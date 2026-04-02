import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { apiReference } from '@scalar/hono-api-reference'
import type { WorkflowClient } from '@temporalio/client'
import type { ConnectorResolver } from '@stripe/sync-engine'
import { createSchemas } from '../lib/createSchemas.js'
import type { Pipeline } from '../lib/createSchemas.js'
import type { WorkflowStatus } from '../temporal/workflows.js'

// MARK: - Helpers

function endpointTable(spec: { paths?: Record<string, unknown> }) {
  const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])
  const rows = Object.entries(spec.paths ?? {}).flatMap(([path, methods]) =>
    Object.entries(methods as Record<string, { summary?: string }>)
      .filter(([m]) => HTTP_METHODS.has(m))
      .map(([method, op]) => `| ${method.toUpperCase()} | ${path} | ${op.summary ?? ''} |`)
  )
  return ['| Method | Path | Summary |', '|--------|------|---------|', ...rows].join('\n')
}

let _idCounter = Date.now()
function genId(prefix: string): string {
  return `${prefix}_${(_idCounter++).toString(36)}`
}

// MARK: - Response schemas (static — don't depend on connector set)

const DeleteResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
})

const ErrorSchema = z.object({ error: z.unknown() })

function ListResponse<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    has_more: z.boolean(),
  })
}

// MARK: - OpenAPI discriminator injection

/**
 * Walk an OpenAPI spec and add `discriminator: { propertyName: "type" }` to
 * every `oneOf` whose variants all define a `type` property with a single enum value.
 * Needed because @hono/zod-openapi doesn't emit discriminator metadata from z.discriminatedUnion.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addDiscriminators(node: any): void {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) addDiscriminators(item)
    return
  }
  if (Array.isArray(node.oneOf)) {
    const allHaveTypeEnum = node.oneOf.every(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (v: any) =>
        v?.type === 'object' &&
        v?.properties?.type?.enum?.length === 1
    )
    if (allHaveTypeEnum && !node.discriminator) {
      node.discriminator = { propertyName: 'type' }
    }
  }
  for (const value of Object.values(node)) {
    addDiscriminators(value)
  }
}

// MARK: - App factory

export interface AppOptions {
  temporal: { client: WorkflowClient; taskQueue: string }
  resolver: ConnectorResolver
}

export function createApp(options: AppOptions) {
  const { client: temporal, taskQueue } = options.temporal
  const {
    Pipeline: PipelineSchema,
    CreatePipeline: CreatePipelineSchema,
    UpdatePipeline: UpdatePipelineSchema,
  } = createSchemas(options.resolver)

  const PipelineWithStatusSchema = PipelineSchema.extend({
    status: z
      .object({
        phase: z.string(),
        paused: z.boolean(),
        iteration: z.number(),
      })
      .optional(),
  })

  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.issues }, 400)
      }
    },
  })

  // ── Path param schemas ──────────────────────────────────────────

  const PipelineIdParam = z.object({
    id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: 'pipe_abc123' }),
  })

  // ── Health ──────────────────────────────────────────────────────

  app.openapi(
    createRoute({
      operationId: 'health',
      method: 'get',
      path: '/health',
      tags: ['Status'],
      summary: 'Health check',
      responses: {
        200: {
          content: {
            'application/json': { schema: z.object({ ok: z.literal(true) }) },
          },
          description: 'Server is healthy',
        },
      },
    }),
    (c) => c.json({ ok: true as const }, 200)
  )

  // MARK: - Pipelines

  app.openapi(
    createRoute({
      operationId: 'listPipelines',
      method: 'get',
      path: '/pipelines',
      tags: ['Pipelines'],
      summary: 'List pipelines',
      responses: {
        200: {
          content: {
            'application/json': { schema: ListResponse(PipelineSchema) },
          },
          description: 'List of pipelines',
        },
      },
    }),
    async (c) => {
      const pipelines: Pipeline[] = []
      for await (const wf of temporal.list({ query: `WorkflowType = 'pipelineWorkflow'` })) {
        const memo = wf.memo as { pipeline?: Pipeline } | undefined
        if (memo?.pipeline) pipelines.push(memo.pipeline)
      }
      return c.json({ data: pipelines, has_more: false } as any, 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'createPipeline',
      method: 'post',
      path: '/pipelines',
      tags: ['Pipelines'],
      summary: 'Create pipeline',
      request: {
        body: {
          content: { 'application/json': { schema: CreatePipelineSchema } },
        },
      },
      responses: {
        201: {
          content: { 'application/json': { schema: PipelineSchema } },
          description: 'Created pipeline',
        },
        400: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Invalid input',
        },
      },
    }),
    async (c) => {
      const body = c.req.valid('json')
      const id = genId('pipe')
      const pipeline = { id, ...(body as Record<string, unknown>) } as Pipeline
      await temporal.start('pipelineWorkflow', {
        workflowId: id,
        taskQueue,
        args: [pipeline],
        memo: { pipeline },
      })
      return c.json(pipeline as any, 201)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'getPipeline',
      method: 'get',
      path: '/pipelines/{id}',
      tags: ['Pipelines'],
      summary: 'Retrieve pipeline',
      request: { params: PipelineIdParam },
      responses: {
        200: {
          content: { 'application/json': { schema: PipelineWithStatusSchema } },
          description: 'Retrieved pipeline with status',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      try {
        const handle = temporal.getHandle(id)
        const [pipeline, status] = await Promise.all([
          handle.query<Pipeline>('config'),
          handle.query<WorkflowStatus>('status'),
        ])
        return c.json({ ...pipeline, status } as any, 200)
      } catch {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }
    }
  )

  app.openapi(
    createRoute({
      operationId: 'updatePipeline',
      method: 'patch',
      path: '/pipelines/{id}',
      tags: ['Pipelines'],
      summary: 'Update pipeline',
      request: {
        params: PipelineIdParam,
        body: {
          content: { 'application/json': { schema: UpdatePipelineSchema } },
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: PipelineWithStatusSchema } },
          description: 'Updated pipeline',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const patch = c.req.valid('json')
      try {
        const handle = temporal.getHandle(id)
        await handle.signal('update', patch)
        // Brief wait for signal to be processed before querying
        await new Promise((r) => setTimeout(r, 200))
        const [pipeline, status] = await Promise.all([
          handle.query<Pipeline>('config'),
          handle.query<WorkflowStatus>('status'),
        ])
        return c.json({ ...pipeline, status } as any, 200)
      } catch {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }
    }
  )

  app.openapi(
    createRoute({
      operationId: 'pausePipeline',
      method: 'post',
      path: '/pipelines/{id}/pause',
      tags: ['Pipelines'],
      summary: 'Pause pipeline',
      request: { params: PipelineIdParam },
      responses: {
        200: {
          content: { 'application/json': { schema: PipelineWithStatusSchema } },
          description: 'Paused pipeline',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      try {
        const handle = temporal.getHandle(id)
        await handle.signal('update', { paused: true })
        await new Promise((r) => setTimeout(r, 200))
        const [pipeline, status] = await Promise.all([
          handle.query<Pipeline>('config'),
          handle.query<WorkflowStatus>('status'),
        ])
        return c.json({ ...pipeline, status } as any, 200)
      } catch {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }
    }
  )

  app.openapi(
    createRoute({
      operationId: 'resumePipeline',
      method: 'post',
      path: '/pipelines/{id}/resume',
      tags: ['Pipelines'],
      summary: 'Resume pipeline',
      request: { params: PipelineIdParam },
      responses: {
        200: {
          content: { 'application/json': { schema: PipelineWithStatusSchema } },
          description: 'Resumed pipeline',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      try {
        const handle = temporal.getHandle(id)
        await handle.signal('update', { paused: false })
        await new Promise((r) => setTimeout(r, 200))
        const [pipeline, status] = await Promise.all([
          handle.query<Pipeline>('config'),
          handle.query<WorkflowStatus>('status'),
        ])
        return c.json({ ...pipeline, status } as any, 200)
      } catch {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }
    }
  )

  app.openapi(
    createRoute({
      operationId: 'deletePipeline',
      method: 'delete',
      path: '/pipelines/{id}',
      tags: ['Pipelines'],
      summary: 'Delete pipeline',
      request: { params: PipelineIdParam },
      responses: {
        200: {
          content: { 'application/json': { schema: DeleteResponseSchema } },
          description: 'Deleted pipeline',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      try {
        await temporal.getHandle(id).signal('delete')
        return c.json({ id, deleted: true as const }, 200)
      } catch {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }
    }
  )

  // MARK: - Webhook ingress

  const WebhookParam = z.object({
    pipeline_id: z.string().openapi({
      param: { name: 'pipeline_id', in: 'path' },
      example: 'pipe_abc123',
    }),
  })

  app.openapi(
    createRoute({
      operationId: 'pushWebhook',
      method: 'post',
      path: '/webhooks/{pipeline_id}',
      tags: ['Webhooks'],
      summary: 'Ingest a Stripe webhook event',
      description:
        "Receives a raw Stripe webhook event, verifies its signature using the pipeline's webhook secret, and enqueues it for processing by the active pipeline.",
      request: { params: WebhookParam },
      responses: {
        200: {
          content: { 'text/plain': { schema: z.literal('ok') } },
          description: 'Event accepted',
        },
      },
    }),
    async (c) => {
      const { pipeline_id } = c.req.valid('param')
      const body = await c.req.text()
      const headers = Object.fromEntries(c.req.raw.headers.entries())
      temporal.getHandle(pipeline_id).signal('stripe_event', { body, headers }).catch(() => {})
      return c.text('ok', 200)
    }
  )

  // MARK: - OpenAPI spec + Swagger UI

  app.get('/openapi.json', (c) => {
    const spec = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: {
        title: 'Stripe Sync Service',
        version: '1.0.0',
        description: 'Stripe Sync Service — manage pipelines and webhook ingress.',
      },
    })
    spec.info.description += '\n\n## Endpoints\n\n' + endpointTable(spec)
    // @hono/zod-openapi doesn't emit discriminator for z.discriminatedUnion —
    // walk the spec and inject it wherever oneOf variants share a `type` enum.
    addDiscriminators(spec)
    return c.json(spec)
  })

  app.get('/docs', apiReference({ url: '/openapi.json' }))

  return app
}
