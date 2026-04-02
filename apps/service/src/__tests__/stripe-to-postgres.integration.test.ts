/**
 * Integration test: Stripe → Postgres via pipelineWorkflow
 *
 * Requires (all provided by `docker compose up`):
 *   - stripe-mock at STRIPE_MOCK_URL (default: http://localhost:12111)
 *   - Temporal at TEMPORAL_ADDRESS (default: localhost:7233)
 *   - Postgres at POSTGRES_URL (default: postgresql://postgres:postgres@localhost:55432/postgres)
 *   - `pnpm build` (Temporal worker needs compiled dist/temporal/workflows.js)
 *
 * Run: pnpm test:integration
 */
import net from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import pg from 'pg'
import { Connection, Client } from '@temporalio/client'
import { NativeConnection, Worker } from '@temporalio/worker'
import source from '@stripe/sync-source-stripe'
import destination from '@stripe/sync-destination-postgres'
import { createConnectorResolver, createApp as createEngineApp } from '@stripe/sync-engine'
import { createActivities } from '../temporal/activities.js'
import { pipelineWorkflow, deleteSignal, statusQuery } from '../temporal/workflows.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STRIPE_MOCK_URL = process.env.STRIPE_MOCK_URL ?? 'http://localhost:12111'
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233'
const POSTGRES_URL =
  process.env.POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:55432/postgres'
const STREAM = process.env.STRIPE_SYNC_STREAM ?? 'products'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo
      const port = addr.port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

async function pollUntil(
  fn: () => Promise<boolean>,
  { timeout = 60_000, interval = 1000 } = {}
): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`pollUntil timed out after ${timeout}ms`)
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

let pool: pg.Pool
let schema: string

let engineServer: ServerType
let engineUrl: string

let temporalClient: Client
let temporalConnection: Connection
let nativeConnection: NativeConnection

const workflowsPath = path.resolve(process.cwd(), 'dist/temporal/workflows.js')

beforeAll(async () => {
  schema = `integration_${Date.now()}`

  // 1. Postgres
  pool = new pg.Pool({ connectionString: POSTGRES_URL })
  await pool.query('SELECT 1')

  // 2. Connectors
  const connectors = createConnectorResolver({
    sources: { stripe: source },
    destinations: { postgres: destination },
  })

  // 3. Engine HTTP server
  const enginePort = await findFreePort()
  const engineApp = createEngineApp(connectors)
  engineServer = serve({ fetch: engineApp.fetch, port: enginePort })
  engineUrl = `http://localhost:${enginePort}`

  // 4. Temporal client (retry — auto-setup container may still be initializing)
  for (let i = 0; i < 30; i++) {
    try {
      temporalConnection = await Connection.connect({ address: TEMPORAL_ADDRESS })
      break
    } catch {
      if (i === 29) throw new Error(`Could not connect to Temporal at ${TEMPORAL_ADDRESS}`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  temporalClient = new Client({ connection: temporalConnection })
  nativeConnection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS })

  console.log(`\n  Engine:   ${engineUrl}`)
  console.log(`  Temporal: ${TEMPORAL_ADDRESS}`)
  console.log(`  Postgres: ${POSTGRES_URL} (schema: ${schema})`)
}, 60_000)

afterAll(async () => {
  if (pool && !process.env.KEEP_TEST_DATA) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  }
  await pool?.end().catch(() => {})
  engineServer?.close()
  await temporalConnection?.close().catch(() => {})
  await nativeConnection?.close().catch(() => {})
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pipelineWorkflow: Stripe → Postgres (real Temporal + real Stripe + real Postgres)', () => {
  it('backfills Stripe data to Postgres via read+write workflow', async () => {
    const pipeline = {
      id: `pipe_integration_${Date.now()}`,
      source: {
        name: 'stripe',
        api_key: 'sk_test_fake',
        base_url: STRIPE_MOCK_URL,
      },
      destination: {
        name: 'postgres',
        connection_string: POSTGRES_URL,
        schema,
      },
      streams: [{ name: STREAM }],
    }
    console.log(`  Pipeline: ${pipeline.id}`)

    const worker = await Worker.create({
      connection: nativeConnection,
      taskQueue: 'integration-pg-queue',
      workflowsPath,
      activities: createActivities({ engineUrl }),
    })

    await worker.runUntil(async () => {
      const handle = await temporalClient.workflow.start(pipelineWorkflow, {
        args: [pipeline],
        workflowId: `integration-pg-${pipeline.id}`,
        taskQueue: 'integration-pg-queue',
      })

      // Wait for at least one row to appear in the target table
      await pollUntil(
        async () => {
          try {
            const r = await pool.query(`SELECT count(*) AS cnt FROM "${schema}"."${STREAM}"`)
            return parseInt(r.rows[0].cnt, 10) > 0
          } catch {
            return false
          }
        },
        { timeout: 60_000, interval: 2000 }
      )

      const status = await handle.query(statusQuery)
      expect(status.iteration).toBeGreaterThan(0)
      console.log(`  Iterations: ${status.iteration}`)

      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${schema}"."${STREAM}"`)
      console.log(`  Rows synced: ${rows[0].n}`)
      expect(rows[0].n).toBeGreaterThan(0)

      await handle.signal(deleteSignal)
      await handle.result()
    })
  }, 120_000)
})
