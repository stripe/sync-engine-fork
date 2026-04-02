import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { Client, Connection } from '@temporalio/client'
import { NativeConnection, Worker } from '@temporalio/worker'
import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { execSync } from 'node:child_process'
import createFetchClient from 'openapi-fetch'
import pg from 'pg'
import sourceStripe from '@stripe/sync-source-stripe'
import destinationPostgres from '@stripe/sync-destination-postgres'
import { createApp as createEngineApp, createConnectorResolver } from '@stripe/sync-engine'
import { createActivities } from '../temporal/activities.js'
import { createApp } from './app.js'
import type { paths } from '../__generated__/openapi.js'

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------

const TEMPORAL_ADDRESS = process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233'
const STRIPE_MOCK_URL = process.env['STRIPE_MOCK_URL'] ?? 'http://localhost:12111'
const POSTGRES_URL = process.env['POSTGRES_URL'] ?? process.env['DATABASE_URL']!
const TASK_QUEUE = `test-app-${Date.now()}`
const SCHEMA = `integration_${Date.now()}`
const workflowsPath = path.resolve(process.cwd(), 'dist/temporal/workflows.js')

// Set CLEANUP=1 to drop the test schema after the run
const CLEANUP = process.env['CLEANUP'] === '1'

// ---------------------------------------------------------------------------
// Real connectors, real servers, real Temporal
// ---------------------------------------------------------------------------

const resolver = createConnectorResolver({
  sources: { stripe: sourceStripe },
  destinations: { postgres: destinationPostgres },
})

let client: Client
let worker: Worker
let workerRunning: Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let engineServer: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serviceServer: any
let serviceUrl: string
let pool: pg.Pool

beforeAll(async () => {
  // 1. Build service so dist/temporal/workflows.js is fresh
  execSync('pnpm --filter @stripe/sync-service build', {
    cwd: path.resolve(process.cwd(), '../..'),
    stdio: 'pipe',
  })

  // 2. Postgres pool
  pool = new pg.Pool({ connectionString: POSTGRES_URL })
  await pool.query('SELECT 1')

  // 3. Start real engine HTTP server on random port
  //    Raise maxHeaderSize — X-State header grows large with many Stripe streams
  const engineApp = createEngineApp(resolver)
  const engineUrl = await new Promise<string>((resolve) => {
    engineServer = serve(
      {
        fetch: engineApp.fetch,
        port: 0,
        serverOptions: { maxHeaderSize: 128 * 1024 },
      },
      (info) => {
        resolve(`http://localhost:${(info as AddressInfo).port}`)
      }
    )
  })

  // 4. Connect to real Temporal (Docker)
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS })
  client = new Client({ connection })

  // 5. Start worker with real workflows + real activities
  const nativeConnection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS })
  worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath,
    activities: createActivities({ engineUrl }),
  })
  workerRunning = worker.run()

  // 6. Start real service HTTP server on random port
  const serviceApp = createApp({
    temporal: { client: client.workflow, taskQueue: TASK_QUEUE },
    resolver,
  })
  serviceUrl = await new Promise<string>((resolve) => {
    serviceServer = serve({ fetch: serviceApp.fetch, port: 0 }, (info) => {
      resolve(`http://localhost:${(info as AddressInfo).port}`)
    })
  })

  console.log(`  Schema:   ${SCHEMA}`)
  console.log(`  Postgres: ${POSTGRES_URL}`)
  console.log(`  Cleanup:  ${CLEANUP ? 'yes' : 'no (set CLEANUP=1 to drop schema)'}`)
}, 60_000)

afterAll(async () => {
  worker?.shutdown()
  await workerRunning
  await new Promise<void>((r, e) => engineServer?.close((err: Error | null) => (err ? e(err) : r())))
  await new Promise<void>((r, e) =>
    serviceServer?.close((err: Error | null) => (err ? e(err) : r()))
  )
  if (CLEANUP) {
    await pool?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {})
  }
  await pool?.end().catch(() => {})
})

function api() {
  return createFetchClient<paths>({ baseUrl: serviceUrl })
}

async function pollUntil(
  fn: () => Promise<boolean>,
  { timeout = 60_000, interval = 2000 } = {}
): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`pollUntil timed out after ${timeout}ms`)
}

// ---------------------------------------------------------------------------
// Pipeline CRUD + data verification
// ---------------------------------------------------------------------------

describe('pipelines (integration)', () => {
  it('create → data lands in Postgres → delete', async () => {
    const c = api()

    // Create pipeline targeting a unique schema
    const { data: created, error: createErr } = await c.POST('/pipelines', {
      body: {
        source: { type: 'stripe', api_key: 'sk_test_fake', base_url: STRIPE_MOCK_URL },
        destination: { type: 'postgres', connection_string: POSTGRES_URL, schema: SCHEMA },
        streams: [{ name: 'products' }],
      },
    })
    expect(createErr).toBeUndefined()
    expect(created!.id).toMatch(/^pipe_/)
    const id = created!.id

    // Wait for workflow to start and become queryable
    await new Promise((r) => setTimeout(r, 1000))

    // Get (includes status from workflow query)
    const { data: got, error: getErr } = await c.GET('/pipelines/{id}', {
      params: { path: { id } },
    })
    expect(getErr).toBeUndefined()
    expect(got!.status?.phase).toBeDefined()

    // List
    const { data: list, error: listErr } = await c.GET('/pipelines')
    expect(listErr).toBeUndefined()
    expect(list!.data.length).toBeGreaterThanOrEqual(1)

    // Wait for data to land in Postgres
    await pollUntil(async () => {
      try {
        const r = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}"."products"`)
        return r.rows[0].n > 0
      } catch {
        return false
      }
    })

    // Verify rows
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}"."products"`)
    console.log(`  Synced ${rows[0].n} products`)
    expect(rows[0].n).toBeGreaterThan(0)

    // Verify data shape
    const { rows: sample } = await pool.query(
      `SELECT id FROM "${SCHEMA}"."products" LIMIT 1`
    )
    expect(sample[0].id).toMatch(/^prod_/)

    // Update — returns full pipeline with status
    const { data: updated, error: updateErr } = await c.PATCH('/pipelines/{id}', {
      params: { path: { id } },
      body: { streams: [{ name: 'customers' }] },
    })
    expect(updateErr).toBeUndefined()
    expect(updated!.id).toBe(id)
    expect(updated!.status).toBeDefined()

    // Delete (signals workflow to teardown)
    const { data: deleted, error: deleteErr } = await c.DELETE('/pipelines/{id}', {
      params: { path: { id } },
    })
    expect(deleteErr).toBeUndefined()
    expect(deleted).toEqual({ id, deleted: true })

    // Wait for workflow to complete
    const handle = client.workflow.getHandle(id)
    await handle.result()
  }, 60_000)

  it('returns 404 for non-existent pipeline', async () => {
    const { error } = await api().GET('/pipelines/{id}', {
      params: { path: { id: 'pipe_nope' } },
    })
    expect(error).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Webhook ingress
// ---------------------------------------------------------------------------

describe('POST /webhooks/:pipeline_id (integration)', () => {
  it('accepts webhook events and returns ok', async () => {
    const { data, response } = await api().POST('/webhooks/{pipeline_id}', {
      params: { path: { pipeline_id: 'pipe_abc123' } },
      body: { type: 'checkout.session.completed' } as any,
      parseAs: 'text',
    })
    expect(response.status).toBe(200)
    expect(data).toBe('ok')
  })
})
