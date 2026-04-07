import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import pg from 'pg'
import {
  startDockerPostgres18,
  createStripeListServer,
  resolveEndpointSet,
  ensureObjectTable,
  upsertObjects,
  generateStubObjects,
  applyCreatedTimestampRange,
  type DockerPostgres18Handle,
  type StripeListServer,
  type EndpointDefinition,
} from '@stripe/sync-test-utils'
import { createEngine, readonlyStateStore, type PipelineConfig } from '@stripe/sync-engine'
import sourceStripe, { type StripeStreamState } from '@stripe/sync-source-stripe'
import destinationPostgres from '@stripe/sync-destination-postgres'
import type { DestinationOutput } from '@stripe/sync-protocol'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STRIPE_MOCK_URL = 'http://localhost:12111'
const OBJECTS_PER_STREAM = 10_000
const SEED_BATCH = 1000
const RATE_LIMIT = 1_000
const KEEP_TEST_DBS = process.env.KEEP_TEST_DBS === '1'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sourceDocker: DockerPostgres18Handle
let destDocker: DockerPostgres18Handle
let testServer: StripeListServer
let sourcePool: pg.Pool
let destPool: pg.Pool
let endpoints: Map<string, EndpointDefinition>

type StreamSeed = { tableName: string; isV2: boolean; objectIds: string[] }
let seededStreams: StreamSeed[]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureStripeMock(): Promise<void> {
  execSync('docker compose up -d stripe-mock', {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: 'pipe',
  })
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${STRIPE_MOCK_URL}/v1/customers`, {
        headers: { Authorization: 'Bearer sk_test_fake' },
      })
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('stripe-mock did not become ready')
}

async function fetchTemplate(endpoint: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${STRIPE_MOCK_URL}${endpoint}`, {
    headers: { Authorization: 'Bearer sk_test_fake' },
  })
  if (!res.ok) return []
  const body = (await res.json()) as { data?: unknown[] }
  if (!Array.isArray(body.data)) return []
  return body.data.filter(
    (item): item is Record<string, unknown> =>
      item != null &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).id === 'string'
  )
}

function replicateToCount(
  templates: Record<string, unknown>[],
  target: number
): Record<string, unknown>[] {
  if (templates.length === 0) return []
  const result = [...templates]
  let counter = 0
  while (result.length < target) {
    const template = templates[result.length % templates.length]
    const id = typeof template.id === 'string' ? template.id : ''
    const prefix = id.replace(/_[^_]+$/, '')
    result.push({
      ...template,
      id: `${prefix}_gen${String(counter++).padStart(6, '0')}`,
    })
  }
  return result
}

/** Convert a UTC date string to a Unix timestamp in seconds. */
function utc(date: string): number {
  return Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000)
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

describe('test-server all objects', () => {
  const RANGE_START = utc('2021-04-03')
  const RANGE_END = utc('2026-04-02')

  beforeAll(async () => {
    await ensureStripeMock()

    const [src, dest, endpointSet] = await Promise.all([
      startDockerPostgres18(),
      startDockerPostgres18(),
      resolveEndpointSet({}),
    ])
    sourceDocker = src
    destDocker = dest
    endpoints = endpointSet.endpoints

    sourcePool = new pg.Pool({ connectionString: sourceDocker.connectionString })
    destPool = new pg.Pool({ connectionString: destDocker.connectionString })

    // Start test server first — it creates the schema and resolves endpoints
    testServer = await createStripeListServer({
      postgresUrl: sourceDocker.connectionString,
      accountCreated: RANGE_START,
    })

    // Seed every endpoint with OBJECTS_PER_STREAM objects
    const createdRange = { startUnix: RANGE_START, endUnix: RANGE_END }
    seededStreams = []

    const sortedEndpoints = [...endpoints.values()].sort((a, b) =>
      a.tableName.localeCompare(b.tableName)
    )

    console.log(`  Seeding ${sortedEndpoints.length} streams × ${OBJECTS_PER_STREAM} objects...`)

    for (const ep of sortedEndpoints) {
      await ensureObjectTable(sourcePool, 'stripe', ep.tableName)

      let objects: Record<string, unknown>[]
      if (ep.isV2) {
        objects = generateStubObjects(ep, OBJECTS_PER_STREAM)
      } else {
        const templates = await fetchTemplate(ep.apiPath)
        if (templates.length === 0) {
          objects = generateStubObjects(ep, OBJECTS_PER_STREAM)
        } else {
          objects = replicateToCount(templates, OBJECTS_PER_STREAM)
          objects = applyCreatedTimestampRange(objects, createdRange)
        }
      }

      // Deduplicate IDs (replication can sometimes collide with templates)
      const seen = new Set<string>()
      objects = objects.filter((o) => {
        const id = o.id as string
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })

      for (let i = 0; i < objects.length; i += SEED_BATCH) {
        await upsertObjects(sourcePool, 'stripe', ep.tableName, objects.slice(i, i + SEED_BATCH))
      }

      const ids = objects.map((o) => o.id as string)
      seededStreams.push({ tableName: ep.tableName, isV2: ep.isV2, objectIds: ids })
    }

    const totalSeeded = seededStreams.reduce((sum, s) => sum + s.objectIds.length, 0)
    console.log(`  Seeded ${totalSeeded} total objects across ${seededStreams.length} streams`)

    console.log(`  Source PG:     ${sourceDocker.connectionString}`)
    console.log(`  Dest PG:       ${destDocker.connectionString}`)
    console.log(`  Test server:   ${testServer.url}`)
  }, 15 * 60_000)

  afterAll(async () => {
    await testServer?.close().catch(() => {})
    await sourcePool?.end().catch(() => {})
    await destPool?.end().catch(() => {})
    if (KEEP_TEST_DBS) {
      console.log(`  Source PG still running: ${sourceDocker?.connectionString}`)
      console.log(`  Dest PG still running:   ${destDocker?.connectionString}`)
      return
    }
    await destDocker?.stop()
    await sourceDocker?.stop()
  }, 60_000)

  // ---------------------------------------------------------------------------
  // Test: sync all objects and verify by ID
  // ---------------------------------------------------------------------------

  it(
    'syncs all v1 and v2 streams and verifies every object by ID',
    async () => {
      const destSchema = `all_objects_${Date.now()}`

      const streams: PipelineConfig['streams'] = seededStreams.map((s) => ({
        name: s.tableName,
        sync_mode: 'full_refresh' as const,
      }))

      const pipeline: PipelineConfig = {
        source: {
          type: 'stripe',
          api_key: 'sk_test_fake',
          api_version: '2025-04-30.basil',
          base_url: testServer.url,
          rate_limit: RATE_LIMIT,
          backfill_concurrency: 5,
        },
        destination: {
          type: 'postgres',
          connection_string: destDocker.connectionString,
          schema: destSchema,
          batch_size: 100,
        },
        streams,
      }

      console.log(`  Syncing ${streams.length} streams at ${RATE_LIMIT} req/s...`)

      // No pre-built state — let the engine discover the range from the
      // test server's account created timestamp and build segments itself.
      const engine = createEngine(
        pipeline,
        { source: sourceStripe, destination: destinationPostgres },
        readonlyStateStore()
      )

      const messages: DestinationOutput[] = []
      const finalState: Record<string, unknown> = {}
      for await (const msg of engine.sync()) {
        messages.push(msg)
        if (msg.type === 'state') {
          finalState[msg.stream] = msg.data
        }
      }

      // Verify every stream
      const failures: string[] = []
      let totalVerified = 0

      for (const seed of seededStreams) {
        const { rows } = await destPool.query(
          `SELECT id FROM "${destSchema}"."${seed.tableName}" ORDER BY id`
        )
        const destIds = new Set(rows.map((r: { id: string }) => r.id))
        const expectedIds = new Set(seed.objectIds)

        const missing = [...expectedIds].filter((id) => !destIds.has(id))
        const unexpected = [...destIds].filter((id) => !expectedIds.has(id))

        if (missing.length > 0) {
          failures.push(
            `${seed.tableName}: missing ${missing.length} objects (first 5: ${missing.slice(0, 5).join(', ')})`
          )
        }
        if (unexpected.length > 0) {
          failures.push(`${seed.tableName}: ${unexpected.length} unexpected objects`)
        }
        if (rows.length !== seed.objectIds.length) {
          failures.push(
            `${seed.tableName}: expected ${seed.objectIds.length} rows, got ${rows.length}`
          )
        }

        totalVerified += rows.length
      }

      console.log(`  Verified ${totalVerified} objects across ${seededStreams.length} streams`)

      if (failures.length > 0) {
        console.log(`  Failures:\n    ${failures.join('\n    ')}`)
      }

      expect(failures, failures.join('\n')).toHaveLength(0)

      // Verify every stream reached 'complete'
      for (const seed of seededStreams) {
        const streamState = finalState[seed.tableName] as StripeStreamState | undefined
        expect(
          streamState?.status,
          `${seed.tableName} did not complete (status: ${streamState?.status})`
        ).toBe('complete')
      }

      await destPool.query(`DROP SCHEMA IF EXISTS "${destSchema}" CASCADE`)
    },
    30 * 60_000
  )
})
