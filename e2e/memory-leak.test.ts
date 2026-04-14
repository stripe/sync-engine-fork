import { execSync, spawn, type ChildProcess } from 'node:child_process'
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

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SOURCE_SCHEMA = 'stripe'
const DEST_SCHEMA = 'leak_test'
const CUSTOMER_COUNT = 5_000
const SEED_BATCH = 1000

const WARMUP_ITERATIONS = 25
const TEST_ITERATIONS = 50
const TIME_LIMIT_SECONDS = 2

const RANGE_START = Math.floor(new Date('2021-04-03T00:00:00Z').getTime() / 1000)
const RANGE_END = Math.floor(new Date('2026-04-02T00:00:00Z').getTime() / 1000)

// ── RSS measurement ──────────────────────────────────────────────

function getRssKb(pid: number): number | null {
  try {
    const raw = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8' }).trim()
    const kb = parseInt(raw, 10)
    return Number.isFinite(kb) ? kb : null
  } catch {
    return null
  }
}

/** Least-squares slope: KB growth per iteration. */
function linearRegressionSlope(ys: number[]): number {
  const n = ys.length
  if (n < 2) return 0
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumXX = 0
  for (let i = 0; i < n; i++) {
    sumX += i
    sumY += ys[i]
    sumXY += i * ys[i]
    sumXX += i * i
  }
  return (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX)
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

async function drainResponse(res: Response): Promise<void> {
  const reader = res.body?.getReader()
  if (!reader) return
  while (true) {
    const { done } = await reader.read()
    if (done) break
  }
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
    await drainResponse(setupRes)
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
    const rssSamples: number[] = []
    const totalIterations = WARMUP_ITERATIONS + TEST_ITERATIONS

    for (let i = 0; i < totalIterations; i++) {
      const res = await fetch(
        `http://localhost:${enginePort}/pipeline_sync?time_limit=${TIME_LIMIT_SECONDS}`,
        { method: 'POST', headers: { 'X-Pipeline': pipelineHeader } }
      )
      await drainResponse(res)

      // Brief pause to let GC run
      await new Promise((r) => setTimeout(r, 500))

      const rss = getRssKb(pid)
      if (rss !== null) rssSamples.push(rss)
    }

    // ── Log RSS table for CI debugging ─────────────────────────
    console.log('\n  RSS samples (MB):')
    console.log('   iter  │  RSS (MB)  │  delta')
    console.log('  ──────┼────────────┼────────')
    for (let i = 0; i < rssSamples.length; i++) {
      const mb = (rssSamples[i] / 1024).toFixed(1)
      const delta =
        i > 0 ? ((rssSamples[i] - rssSamples[i - 1]) / 1024).toFixed(1) : '—'
      const marker = i === WARMUP_ITERATIONS ? ' ← warmup end' : ''
      console.log(
        `  ${String(i + 1).padStart(4)}  │  ${mb.padStart(8)}  │  ${String(delta).padStart(6)}${marker}`
      )
    }

    // ── Assertions on post-warmup samples ──────────────────────
    const postWarmup = rssSamples.slice(WARMUP_ITERATIONS)
    expect(
      postWarmup.length,
      'Not enough post-warmup samples'
    ).toBeGreaterThanOrEqual(TEST_ITERATIONS * 0.8)

    const slope = linearRegressionSlope(postWarmup)
    const totalGrowthKb = postWarmup[postWarmup.length - 1] - postWarmup[0]
    const totalGrowthMb = totalGrowthKb / 1024

    console.log(`\n  Post-warmup analysis:`)
    console.log(`    Baseline RSS:   ${(postWarmup[0] / 1024).toFixed(1)} MB`)
    console.log(`    Final RSS:      ${(postWarmup[postWarmup.length - 1] / 1024).toFixed(1)} MB`)
    console.log(`    Total growth:   ${totalGrowthMb.toFixed(1)} MB`)
    console.log(`    Slope:          ${slope.toFixed(1)} KB/iteration`)

    // Slope: average KB growth per iteration should be small.
    // Before the fix, the leak grows ~50-100 MB per 60s window.
    // With short 2s windows, that's still ~2-5 MB/iter on a leaky build.
    // A healthy build should show <500 KB/iter (noise from GC, caches).
    expect(slope, `RSS slope ${slope.toFixed(0)} KB/iter exceeds threshold`).toBeLessThan(500)

    // Total post-warmup growth should stay under 200 MB
    expect(
      totalGrowthMb,
      `Total RSS growth ${totalGrowthMb.toFixed(0)} MB exceeds 200 MB`
    ).toBeLessThan(200)
  })
})
