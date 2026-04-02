import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { Client, Connection } from '@temporalio/client'
import { NativeConnection, Worker } from '@temporalio/worker'
import createFetchClient from 'openapi-fetch'
import path from 'node:path'
import { createApp } from './app.js'
import type { paths } from '../__generated__/openapi.js'
import type { SyncActivities } from '../temporal/activities.js'
import type { RunResult } from '../temporal/types.js'

// ---------------------------------------------------------------------------
// Temporal setup — real server (Docker), no-op activities
// ---------------------------------------------------------------------------

const TEMPORAL_ADDRESS = process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233'
const TASK_QUEUE = `test-app-${Date.now()}`
const workflowsPath = path.resolve(process.cwd(), 'dist/temporal/workflows.js')

const noopActivities: SyncActivities = {
  setup: async () => {},
  sync: async (): Promise<RunResult> => ({ errors: [], state: {} }),
  read: async () => ({ count: 0, state: {} }),
  write: async () => ({ errors: [], state: {}, written: 0 }),
  teardown: async () => {},
}

let client: Client
let worker: Worker
let workerRunning: Promise<void>

beforeAll(async () => {
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS })
  client = new Client({ connection })

  const nativeConnection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS })
  worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath,
    activities: noopActivities,
  })
  workerRunning = worker.run()
}, 30_000)

afterAll(async () => {
  worker?.shutdown()
  await workerRunning
})

// ---------------------------------------------------------------------------
// Typed openapi-fetch client backed by Hono app
// ---------------------------------------------------------------------------

function createTestClient() {
  const app = createApp({
    temporal: { client: client.workflow, taskQueue: TASK_QUEUE },
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
        source: { name: 'stripe', api_key: 'sk_test_123' },
        destination: { name: 'postgres', connection_string: 'postgres://localhost/db' },
        streams: [{ name: 'customers' }],
      },
    })
    expect(createErr).toBeUndefined()
    expect(created!.id).toMatch(/^pipe_/)
    expect(created!.source.name).toBe('stripe')

    const id = created!.id

    // Wait for workflow to start and become queryable
    await new Promise((r) => setTimeout(r, 500))

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
