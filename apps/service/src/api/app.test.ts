import { describe, expect, it } from 'vitest'
import type { WorkflowClient } from '@temporalio/client'
import { createApp } from './app.js'
import type { Pipeline } from '../lib/schemas.js'

// ---------------------------------------------------------------------------
// Mock Temporal client — in-memory pipeline storage
// ---------------------------------------------------------------------------

function mockWorkflowClient(): WorkflowClient {
  const store = new Map<string, { pipeline: Pipeline; paused: boolean }>()

  return {
    start(_workflow: string, options: any) {
      const [pipeline] = options.args as [Pipeline]
      store.set(options.workflowId, { pipeline, paused: false })
      return Promise.resolve({ workflowId: options.workflowId })
    },
    getHandle(workflowId: string) {
      return {
        signal(signalName: string, ...args: unknown[]) {
          const entry = store.get(workflowId)
          if (!entry) return Promise.reject(new Error(`Workflow not found: ${workflowId}`))
          if (signalName === 'delete') {
            store.delete(workflowId)
          } else if (signalName === 'update') {
            const patch = args[0] as Record<string, unknown>
            if (patch.source) entry.pipeline.source = patch.source as any
            if (patch.destination) entry.pipeline.destination = patch.destination as any
            if (patch.streams !== undefined) entry.pipeline.streams = patch.streams as any
            if ('paused' in patch) entry.paused = !!patch.paused
          }
          return Promise.resolve()
        },
        query(queryName: string) {
          const entry = store.get(workflowId)
          if (!entry) return Promise.reject(new Error(`Workflow not found: ${workflowId}`))
          if (queryName === 'config') return Promise.resolve(entry.pipeline)
          if (queryName === 'status')
            return Promise.resolve({ phase: 'running', paused: entry.paused, iteration: 1 })
          if (queryName === 'state') return Promise.resolve({})
          return Promise.reject(new Error(`Unknown query: ${queryName}`))
        },
        terminate() {
          store.delete(workflowId)
          return Promise.resolve()
        },
      }
    },
    list() {
      const entries = [...store.values()]
      return {
        async *[Symbol.asyncIterator]() {
          for (const entry of entries) {
            yield { memo: { pipeline: entry.pipeline } }
          }
        },
      }
    },
  } as unknown as WorkflowClient
}

function app() {
  return createApp({
    temporal: { client: mockWorkflowClient(), taskQueue: 'test' },
  })
}

// ---------------------------------------------------------------------------
// OpenAPI spec
// ---------------------------------------------------------------------------

describe('GET /openapi.json', () => {
  it('returns a valid OpenAPI 3.0 spec', async () => {
    const res = await app().request('/openapi.json')
    expect(res.status).toBe(200)
    const spec = await res.json()
    expect(spec.openapi).toBe('3.0.0')
    expect(spec.info.title).toBeDefined()
    expect(spec.paths).toBeDefined()
  })

  it('includes pipeline and webhook paths', async () => {
    const res = await app().request('/openapi.json')
    const spec = (await res.json()) as { paths: Record<string, unknown> }
    const paths = Object.keys(spec.paths)

    expect(paths).toContain('/pipelines')
    expect(paths).toContain('/pipelines/{id}')
    expect(paths).toContain('/webhooks/{pipeline_id}')
  })

  it('does not include removed pipeline operation paths', async () => {
    const res = await app().request('/openapi.json')
    const spec = (await res.json()) as { paths: Record<string, unknown> }
    const paths = Object.keys(spec.paths)

    expect(paths).not.toContain('/pipelines/{id}/sync')
    expect(paths).not.toContain('/pipelines/{id}/setup')
    expect(paths).not.toContain('/pipelines/{id}/teardown')
    expect(paths).not.toContain('/pipelines/{id}/check')
    expect(paths).not.toContain('/pipelines/{id}/read')
    expect(paths).not.toContain('/pipelines/{id}/write')
    expect(paths).not.toContain('/pipelines/{id}/pause')
    expect(paths).not.toContain('/pipelines/{id}/resume')
  })
})

describe('GET /docs', () => {
  it('returns HTML (Scalar API reference)', async () => {
    const res = await app().request('/docs')
    expect(res.status).toBe(200)
    const contentType = res.headers.get('content-type') ?? ''
    expect(contentType).toContain('text/html')
  })
})

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await app().request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// Pipelines CRUD
// ---------------------------------------------------------------------------

describe('pipelines', () => {
  it('create → get → list → update → delete', async () => {
    const a = app()

    // Create pipeline
    const createRes = await a.request('/pipelines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: { name: 'stripe', api_key: 'sk_test_123' },
        destination: { name: 'postgres', connection_string: 'postgres://localhost/db' },
        streams: [{ name: 'customers' }],
      }),
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as any
    expect(created.id).toMatch(/^pipe_/)
    expect(created.source.name).toBe('stripe')

    const pipelineId = created.id

    // Get (includes status from query)
    const getRes = await a.request(`/pipelines/${pipelineId}`)
    expect(getRes.status).toBe(200)
    const got = (await getRes.json()) as any
    expect(got.status.phase).toBe('running')

    // List
    const listRes = await a.request('/pipelines')
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as any
    expect(list.data).toHaveLength(1)
    expect(list.has_more).toBe(false)

    // Update
    const updateRes = await a.request(`/pipelines/${pipelineId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        streams: [{ name: 'products' }],
      }),
    })
    expect(updateRes.status).toBe(200)

    // Delete
    const deleteRes = await a.request(`/pipelines/${pipelineId}`, {
      method: 'DELETE',
    })
    expect(deleteRes.status).toBe(200)
    expect(await deleteRes.json()).toEqual({ id: pipelineId, deleted: true })

    // Get after delete → 404
    const getAfterDelete = await a.request(`/pipelines/${pipelineId}`)
    expect(getAfterDelete.status).toBe(404)
  })

  it('returns 404 for non-existent pipeline', async () => {
    const res = await app().request('/pipelines/pipe_nope')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Webhook ingress
// ---------------------------------------------------------------------------

describe('POST /webhooks/:pipeline_id', () => {
  it('accepts webhook events and returns ok', async () => {
    const res = await app().request('/webhooks/pipe_abc123', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'checkout.session.completed' }),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})
