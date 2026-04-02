import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { Client, Connection } from '@temporalio/client'
import { NativeConnection, Worker } from '@temporalio/worker'
import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { execSync } from 'node:child_process'
import createFetchClient from 'openapi-fetch'
import {
  createApp as createEngineApp,
  createConnectorResolver,
  sourceTest,
  destinationTest,
} from '@stripe/sync-engine'
import { createActivities } from '../temporal/activities.js'
import { createApp } from './app.js'
import type { paths } from '../__generated__/openapi.js'

// ---------------------------------------------------------------------------
// Real infra — Docker Temporal + engine HTTP server + real activities
// ---------------------------------------------------------------------------

const TEMPORAL_ADDRESS = process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233'
const TASK_QUEUE = `test-app-${Date.now()}`
const workflowsPath = path.resolve(process.cwd(), 'dist/temporal/workflows.js')

const resolver = createConnectorResolver({
  sources: { stripe: sourceTest, test: sourceTest },
  destinations: { postgres: destinationTest, test: destinationTest },
})

let client: Client
let worker: Worker
let workerRunning: Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let engineServer: any

beforeAll(async () => {
  // 1. Build service so dist/temporal/workflows.js is fresh
  execSync('pnpm --filter @stripe/sync-service build', {
    cwd: path.resolve(process.cwd(), '../..'),
    stdio: 'pipe',
  })

  // 2. Start engine HTTP server on a random port
  const engineApp = createEngineApp(resolver)
  const engineUrl = await new Promise<string>((resolve) => {
    engineServer = serve({ fetch: engineApp.fetch, port: 0 }, (info) => {
      resolve(`http://localhost:${(info as AddressInfo).port}`)
    })
  })

  // 3. Connect to real Temporal
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS })
  client = new Client({ connection })

  // 4. Start worker with real workflows + real activities
  const nativeConnection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS })
  worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath,
    activities: createActivities({ engineUrl }),
  })
  workerRunning = worker.run()
}, 60_000)

afterAll(async () => {
  worker?.shutdown()
  await workerRunning
  await new Promise<void>((resolve, reject) => {
    engineServer?.close((err: Error | null) => (err ? reject(err) : resolve()))
  })
})

// ---------------------------------------------------------------------------
// Typed openapi-fetch client backed by Hono app
// ---------------------------------------------------------------------------

function createTestClient() {
  const app = createApp({
    temporal: { client: client.workflow, taskQueue: TASK_QUEUE },
    resolver,
  })
  const api = createFetchClient<paths>({
    baseUrl: 'http://localhost',
    fetch: app.fetch as unknown as typeof globalThis.fetch,
  })
  return { app, api }
}

// ---------------------------------------------------------------------------
// Pipeline CRUD
// ---------------------------------------------------------------------------

describe('pipelines (integration)', () => {
  it('create → get → list → update → delete', async () => {
    const { api } = createTestClient()

    // Create
    const { data: created, error: createErr } = await api.POST('/pipelines', {
      body: {
        source: { type: 'test' },
        destination: { type: 'test' },
        streams: [{ name: 'customers' }],
      },
    })
    expect(createErr).toBeUndefined()
    expect(created!.id).toMatch(/^pipe_/)
    expect(created!.source.type).toBe('test')

    const id = created!.id

    // Wait for workflow to start and become queryable
    await new Promise((r) => setTimeout(r, 1000))

    // Get (includes status from workflow query)
    const { data: got, error: getErr } = await api.GET('/pipelines/{id}', {
      params: { path: { id } },
    })
    expect(getErr).toBeUndefined()
    expect(got!.status?.phase).toBeDefined()

    // List
    const { data: list, error: listErr } = await api.GET('/pipelines')
    expect(listErr).toBeUndefined()
    expect(list!.data.length).toBeGreaterThanOrEqual(1)

    // Update
    const { data: updated, error: updateErr } = await api.PATCH('/pipelines/{id}', {
      params: { path: { id } },
      body: { streams: [{ name: 'products' }] },
    })
    expect(updateErr).toBeUndefined()
    expect(updated).toEqual({ ok: true })

    // Delete (signals workflow to teardown)
    const { data: deleted, error: deleteErr } = await api.DELETE('/pipelines/{id}', {
      params: { path: { id } },
    })
    expect(deleteErr).toBeUndefined()
    expect(deleted).toEqual({ id, deleted: true })

    // Wait for workflow to actually complete via Temporal handle
    const handle = client.workflow.getHandle(id)
    await handle.result()
  }, 30_000)

  it('returns 404 for non-existent pipeline', async () => {
    const { api } = createTestClient()
    const { error } = await api.GET('/pipelines/{id}', {
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
    const { api } = createTestClient()
    const { data, response } = await api.POST('/webhooks/{pipeline_id}', {
      params: { path: { pipeline_id: 'pipe_abc123' } },
      body: { type: 'checkout.session.completed' } as any,
      parseAs: 'text',
    })
    expect(response.status).toBe(200)
    expect(data).toBe('ok')
  })
})
