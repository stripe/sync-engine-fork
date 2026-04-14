import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyCreatedTimestampRange,
  createStripeListServer,
  ensureObjectTable,
  ensureSchema,
  startDockerPostgres18,
  upsertObjects,
  type DockerPostgres18Handle,
  type StripeListServer,
} from '@stripe/sync-test-utils'
import {
  BUNDLED_API_VERSION,
  generateObjectsFromSchema,
  resolveOpenApiSpec,
} from '@stripe/sync-openapi'
import {
  drainNdjsonResponse,
  formatMemoryLeakSummary,
  formatRssSamplesTable,
  hasTimeLimitEof,
  runMemoryLeakDetector,
  type MemoryLeakSettings,
} from './memory-leak-harness.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SOURCE_SCHEMA = 'stripe'
const DEST_SCHEMA = 'leak_test'
const CUSTOMER_COUNT = 5_000
const SEED_BATCH = 1000

const WARMUP_ITERATIONS = 25
const TEST_ITERATIONS = 50
// Must be short enough that syncs don't complete before the limit fires.
// 5000 rows ÷ 100/page = 50 pages at ~3ms each = ~150ms total.
// time_limit=0.1s processes ~33 pages, guaranteeing early termination.
// Each response must include an eof with reason=time_limit — verified below.
const TIME_LIMIT_SECONDS = 0.1

const RANGE_START = Math.floor(new Date('2021-04-03T00:00:00Z').getTime() / 1000)
const RANGE_END = Math.floor(new Date('2026-04-02T00:00:00Z').getTime() / 1000)

const DETECTOR_SETTINGS: MemoryLeakSettings = {
  warmupIterations: WARMUP_ITERATIONS,
  testIterations: TEST_ITERATIONS,
  settleMs: 500,
  slopeThresholdKb: 3000,
  growthThresholdMb: 300,
}

// ── Engine subprocess management ─────────────────────────────────

function spawnEngine(port: number): { proc: ChildProcess; ready: Promise<void> } {
  // Cast needed: ChildProcessByStdio<null,Readable,Readable> omits EventEmitter
  // methods in Node 24 types, but they exist at runtime.
  const proc = spawn('node', ['apps/engine/dist/api/index.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcess

  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Engine did not start within 30s')), 30_000)
    let output = ''

    // Pino logs to stdout by default
    proc.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.includes('Sync Engine API listening')) {
        clearTimeout(timeout)
        resolve()
      }
    })

    proc.stderr!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })

    proc.on('error', (err: Error) => {
      clearTimeout(timeout)
      reject(err)
    })

    proc.on('exit', (code: number | null) => {
      clearTimeout(timeout)
      reject(new Error(`Engine exited with code ${code} before ready.\noutput: ${output}`))
    })
  })

  return { proc, ready }
}
// ── Test suite ───────────────────────────────────────────────────

describe('memory leak regression', { timeout: 600_000 }, () => {
  let sourceDocker: DockerPostgres18Handle
  let destDocker: DockerPostgres18Handle
  let sourcePool: pg.Pool
  let testServer: StripeListServer
  let engineProc: ChildProcess
  let enginePort: number
  let pipelineHeader: string

  beforeAll(async () => {
    // 1. Start two Postgres containers (source for test server, dest for sync)
    const [src, dst, spec] = await Promise.all([
      startDockerPostgres18(),
      startDockerPostgres18(),
      resolveOpenApiSpec({ apiVersion: BUNDLED_API_VERSION }, fetch).then((r) => r.spec),
    ])
    sourceDocker = src
    destDocker = dst

    // 2. Seed source Postgres with customers
    sourcePool = new pg.Pool({ connectionString: sourceDocker.connectionString })
    sourcePool.on('error', () => {})
    await ensureSchema(sourcePool, SOURCE_SCHEMA)
    await ensureObjectTable(sourcePool, SOURCE_SCHEMA, 'customers')

    const template = generateObjectsFromSchema(spec, 'customer', 1, {
      tableName: 'customers',
    })[0]
    const objects = applyCreatedTimestampRange(
      Array.from({ length: CUSTOMER_COUNT }, (_, i) => ({
        ...template,
        id: `cus_leak_${String(i).padStart(5, '0')}`,
        created: 0,
      })),
      { startUnix: RANGE_START, endUnix: RANGE_END }
    )
    for (let i = 0; i < objects.length; i += SEED_BATCH) {
      await upsertObjects(sourcePool, SOURCE_SCHEMA, 'customers', objects.slice(i, i + SEED_BATCH))
    }
    console.log(`  Seeded ${CUSTOMER_COUNT} customers`)

    // 3. Start custom Stripe list server
    testServer = await createStripeListServer({
      postgresUrl: sourceDocker.connectionString,
      host: '127.0.0.1',
      port: 0,
      accountCreated: RANGE_START,
    })
    console.log(`  Test server: http://127.0.0.1:${testServer.port}`)

    // 4. Spawn engine subprocess
    enginePort = 30000 + Math.floor(Math.random() * 10000)
    const engine = spawnEngine(enginePort)
    engineProc = engine.proc
    await engine.ready
    console.log(`  Engine: http://localhost:${enginePort} (PID ${engineProc.pid})`)

    // 5. Build pipeline config and run setup
    const pipeline = {
      source: {
        type: 'stripe',
        stripe: {
          api_key: 'sk_test_fake',
          api_version: BUNDLED_API_VERSION,
          base_url: `http://127.0.0.1:${testServer.port}`,
          rate_limit: 1000,
        },
      },
      destination: {
        type: 'postgres',
        postgres: {
          connection_string: destDocker.connectionString,
          schema: DEST_SCHEMA,
          batch_size: 100,
        },
      },
      streams: [{ name: 'customers', sync_mode: 'full_refresh' }],
    }
    pipelineHeader = JSON.stringify(pipeline)

    const setupRes = await fetch(`http://localhost:${enginePort}/pipeline_setup`, {
      method: 'POST',
      headers: { 'X-Pipeline': pipelineHeader },
    })
    expect(setupRes.ok, `pipeline_setup failed: ${setupRes.status}`).toBe(true)
    await drainNdjsonResponse(setupRes)
    console.log(`  Pipeline setup complete`)
  }, 120_000)

  afterAll(async () => {
    if (engineProc?.pid) {
      engineProc.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          engineProc.kill('SIGKILL')
          resolve()
        }, 5_000)
        engineProc.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    await testServer?.close().catch(() => {})
    await sourcePool?.end().catch(() => {})
    await destDocker?.stop()
    await sourceDocker?.stop()
  })

  it('RSS does not grow unboundedly during repeated time-limited syncs', { timeout: 300_000 }, async () => {
    const pid = engineProc.pid!
    const result = await runMemoryLeakDetector({
      pid,
      settings: DETECTOR_SETTINGS,
      iterate: async () => {
        const res = await fetch(
          `http://localhost:${enginePort}/pipeline_sync?time_limit=${TIME_LIMIT_SECONDS}`,
          { method: 'POST', headers: { 'X-Pipeline': pipelineHeader } }
        )
        expect(res.ok, `pipeline_sync failed: ${res.status}`).toBe(true)
        const messages = await drainNdjsonResponse(res)
        return { sawTimeLimit: hasTimeLimitEof(messages) }
      },
    })

    console.log(`\n${formatRssSamplesTable(result)}`)
    console.log(`\n${formatMemoryLeakSummary(result)}`)

    // Canary: if time_limit never fires, the leak path is never exercised.
    expect(
      result.timeLimitCount,
      `Only ${result.timeLimitCount}/${result.totalIterations} syncs hit time_limit — ` +
        `the test is not exercising the leak path. Reduce TIME_LIMIT_SECONDS or add more data.`
    ).toBeGreaterThanOrEqual(result.totalIterations * 0.8)

    expect(
      result.postWarmupSamplesKb.length,
      'Not enough post-warmup samples'
    ).toBeGreaterThanOrEqual(TEST_ITERATIONS * 0.8)

    // Before the fix: orphaned iterators accumulate in pending arrays,
    // producing slopes >3000 KB/iter even with short windows.
    // After the fix: RSS plateaus with minor V8 heap noise.
    expect(
      result.slopeKbPerIteration,
      `RSS slope ${result.slopeKbPerIteration.toFixed(0)} KB/iter exceeds threshold`
    ).toBeLessThan(DETECTOR_SETTINGS.slopeThresholdKb)

    expect(
      result.totalGrowthMb,
      `Total RSS growth ${result.totalGrowthMb.toFixed(0)} MB exceeds ${DETECTOR_SETTINGS.growthThresholdMb} MB`
    ).toBeLessThan(DETECTOR_SETTINGS.growthThresholdMb)
  })
})
