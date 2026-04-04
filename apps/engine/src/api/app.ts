import { OpenAPIHono, createRoute } from '@stripe/sync-hono-zod-openapi'
import { z } from 'zod'
import { apiReference } from '@scalar/hono-api-reference'
import { HTTPException } from 'hono/http-exception'
import pg from 'pg'
import type { Message, DestinationOutput, ConnectorResolver } from '../lib/index.js'
import {
  createEngine,
  createConnectorSchemas,
  parseNdjsonStream,
  ConnectorInfo,
  ConnectorListItem,
} from '../lib/index.js'
import { endpointTable } from './openapi-utils.js'
import {
  Message as MessageSchema,
  DiscoverOutput as DiscoverOutputSchema,
  DestinationOutput as DestinationOutputSchema,
} from '@stripe/sync-protocol'

// Raw $refs for NDJSON content schemas — avoids zod-openapi generating *Output
// duplicates when the same Zod schema appears in both request and response positions.
// The actual Zod schemas are registered once via components in getOpenAPI31Document.
const ndjsonRef = {
  Message: { $ref: '#/components/schemas/Message' },
  DiscoverOutput: { $ref: '#/components/schemas/DiscoverOutput' },
  DestinationOutput: { $ref: '#/components/schemas/DestinationOutput' },
  SourceInput: { $ref: '#/components/schemas/SourceInput' },
}
import { ndjsonResponse } from '@stripe/sync-ts-cli/ndjson'
import { logger } from '../logger.js'
import {
  sslConfigFromConnectionString,
  stripSslParams,
  withPgConnectProxy,
} from '@stripe/sync-util-postgres'

// ── Helpers ─────────────────────────────────────────────────────

function syncRequestContext(pipeline: {
  source: { type: string }
  destination: { type: string }
  streams?: Array<{ name: string }>
}) {
  return {
    sourceName: pipeline.source.type,
    destinationName: pipeline.destination.type,
    configuredStreamCount: pipeline.streams?.length ?? 0,
    configuredStreams: pipeline.streams?.map((stream) => stream.name) ?? [],
  }
}

async function* logApiStream<T>(
  label: string,
  iter: AsyncIterable<T>,
  context: Record<string, unknown>,
  startedAt = Date.now()
): AsyncIterable<T> {
  let itemCount = 0
  try {
    for await (const item of iter) {
      itemCount++
      yield item
    }
    logger.info({ ...context, itemCount, durationMs: Date.now() - startedAt }, `${label} completed`)
  } catch (error) {
    logger.error(
      { ...context, itemCount, durationMs: Date.now() - startedAt, err: error },
      `${label} failed`
    )
    throw error
  }
}

// ── App factory ────────────────────────────────────────────────

export async function createApp(resolver: ConnectorResolver) {
  const engine = await createEngine(resolver)

  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.issues }, 400)
      }
    },
  })

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status)
    }
    logger.error({ err }, 'Unhandled error')
    return c.json({ error: 'Internal server error' }, 500)
  })

  /** Node.js 24 sets c.req.raw.body to a non-null empty ReadableStream even for bodyless POSTs. */
  function hasBody(c: { req: { header: (name: string) => string | undefined } }): boolean {
    const cl = c.req.header('Content-Length')
    if (cl !== undefined) return Number(cl) > 0
    if (c.req.header('Transfer-Encoding')) return true
    return false
  }

  // ── Typed header schemas (transform + pipe for runtime validation,
  //    .meta({ param: { content } }) for OAS content encoding) ────

  const { PipelineConfig: TypedPipelineConfig, SourceInput } = createConnectorSchemas(resolver)

  const jsonParse = (s: string, ctx: z.RefinementCtx) => {
    try {
      return JSON.parse(s)
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid JSON' })
      return z.NEVER
    }
  }

  const xPipelineHeader = z
    .string()
    .transform(jsonParse)
    .pipe(TypedPipelineConfig)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .meta({
      description: 'JSON-encoded PipelineConfig',
      param: { content: 'application/json' },
    } as any)

  const xStateHeader = z
    .string()
    .transform(jsonParse)
    .pipe(z.record(z.string(), z.unknown()))
    .optional()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .meta({
      description: 'JSON-encoded per-stream cursor state',
      param: { content: 'application/json' },
    } as any)

  const pipelineHeaders = z.object({ 'x-pipeline': xPipelineHeader })
  const allSyncHeaders = z.object({
    'x-pipeline': xPipelineHeader,
    'x-state': xStateHeader,
  })

  const syncQueryParams = z.object({
    state_limit: z.coerce.number().int().positive().optional().meta({
      description: 'Stop streaming after N state messages.',
      example: '100',
    }),
    time_limit: z.coerce.number().positive().optional().meta({
      description: 'Stop streaming after N seconds.',
      example: '10',
    }),
  })

  const errorResponse = {
    description: 'Invalid params',
    content: {
      'application/json': { schema: z.object({ error: z.unknown() }) },
    },
  } as const

  // ── Routes ─────────────────────────────────────────────────────

  app.openapi(
    createRoute({
      operationId: 'health',
      method: 'get',
      path: '/health',
      tags: ['Status'],
      summary: 'Health check',
      responses: {
        200: {
          content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
          description: 'Server is healthy',
        },
      },
    }),
    (c) => c.json({ ok: true as const }, 200)
  )

  app.openapi(
    createRoute({
      operationId: 'pipeline_setup',
      method: 'post',
      path: '/pipeline_setup',
      tags: ['Stateless Sync API'],
      summary: 'Set up destination schema',
      description:
        'Creates destination tables and applies migrations. Safe to call multiple times.',
      requestParams: { header: pipelineHeaders },
      responses: {
        200: {
          description: 'Setup complete',
          content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
        },
        400: errorResponse,
      },
    }),
    async (c) => {
      const pipeline = c.req.valid('header')['x-pipeline']
      const context = { path: '/pipeline_setup', ...syncRequestContext(pipeline) }
      const startedAt = Date.now()
      logger.info(context, 'Engine API /setup started')
      try {
        const result = await engine.pipeline_setup(pipeline)
        logger.info(
          { ...context, durationMs: Date.now() - startedAt },
          'Engine API /setup completed'
        )
        return c.json(result ?? {}, 200)
      } catch (error) {
        logger.error(
          { ...context, durationMs: Date.now() - startedAt, err: error },
          'Engine API /setup failed'
        )
        throw error
      }
    }
  )

  app.openapi(
    createRoute({
      operationId: 'pipeline_teardown',
      method: 'post',
      path: '/pipeline_teardown',
      tags: ['Stateless Sync API'],
      summary: 'Tear down destination schema',
      description: 'Drops destination tables. Irreversible.',
      requestParams: { header: pipelineHeaders },
      responses: {
        204: { description: 'Teardown complete' },
        400: errorResponse,
      },
    }),
    async (c) => {
      const pipeline = c.req.valid('header')['x-pipeline']
      await engine.pipeline_teardown(pipeline)
      return c.body(null, 204)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'pipeline_check',
      method: 'get',
      path: '/pipeline_check',
      tags: ['Stateless Sync API'],
      summary: 'Check connector connection',
      description: 'Validates the source/destination config and tests connectivity.',
      requestParams: { header: pipelineHeaders },
      responses: {
        200: {
          description: 'Connection check result',
          content: {
            'application/json': {
              schema: z.object({
                source: z.object({
                  status: z.enum(['succeeded', 'failed']),
                  message: z.string().optional(),
                }),
                destination: z.object({
                  status: z.enum(['succeeded', 'failed']),
                  message: z.string().optional(),
                }),
              }),
            },
          },
        },
        400: errorResponse,
      },
    }),
    async (c) => {
      const pipeline = c.req.valid('header')['x-pipeline']
      const result = await engine.pipeline_check(pipeline)
      return c.json(result, 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'source_discover',
      method: 'post',
      path: '/source_discover',
      tags: ['Stateless Sync API'],
      summary: 'Discover available streams',
      description: 'Streams NDJSON messages (catalog, logs, traces) for the configured source.',
      requestParams: { header: pipelineHeaders },
      responses: {
        200: {
          description: 'NDJSON stream of discover messages',
          content: { 'application/x-ndjson': { schema: ndjsonRef.DiscoverOutput } },
        },
        400: errorResponse,
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((c: any) => {
      const pipeline = c.req.valid('header')['x-pipeline']
      return ndjsonResponse(engine.source_discover(pipeline.source))
    }) as any
  )

  // For streaming NDJSON routes the handler returns a raw Response (not c.json),
  // so we cast to `any` to satisfy the typed route handler constraint.

  app.openapi(
    createRoute({
      operationId: 'pipeline_read',
      method: 'post',
      path: '/pipeline_read',
      tags: ['Stateless Sync API'],
      summary: 'Read records from source',
      description:
        'Streams NDJSON messages (records, state, catalog). Optional NDJSON body provides live events as input.',
      requestParams: { header: allSyncHeaders, query: syncQueryParams },
      requestBody: {
        required: false,
        content: {
          'application/x-ndjson': {
            schema: SourceInput ? ndjsonRef.SourceInput : ndjsonRef.Message,
          },
        },
      },
      responses: {
        200: {
          description: 'NDJSON stream of sync messages',
          content: { 'application/x-ndjson': { schema: ndjsonRef.Message } },
        },
        400: errorResponse,
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (c: any) => {
      const pipeline = c.req.valid('header')['x-pipeline']
      const state = c.req.valid('header')['x-state'] as Record<string, unknown> | undefined
      const { state_limit: stateLimit, time_limit: timeLimit } = c.req.valid('query')
      const inputPresent = hasBody(c)
      const context = { path: '/pipeline_read', inputPresent, ...syncRequestContext(pipeline) }
      const startedAt = Date.now()
      logger.info(context, 'Engine API /read started')

      let input: AsyncIterable<unknown> | undefined
      if (inputPresent) {
        const sourceType = pipeline.source.type
        if (SourceInput) {
          // Validate each NDJSON line against the SourceInput discriminated union,
          // then unwrap the connector-specific payload for source.read().
          input = (async function* () {
            for await (const msg of parseNdjsonStream(c.req.raw.body!)) {
              const parsed = SourceInput.parse(msg)
              yield (parsed as Record<string, unknown>)[sourceType]
            }
          })()
        } else {
          input = parseNdjsonStream(c.req.raw.body!)
        }
      }
      const output = engine.pipeline_read(pipeline, { state, stateLimit, timeLimit }, input)
      return ndjsonResponse(logApiStream('Engine API /read', output, context, startedAt))
    }) as any
  )

  app.openapi(
    createRoute({
      operationId: 'pipeline_write',
      method: 'post',
      path: '/pipeline_write',
      tags: ['Stateless Sync API'],
      summary: 'Write records to destination',
      description:
        'Reads NDJSON messages from the request body and writes them to the destination. Pipe /read output as input.',
      requestParams: { header: pipelineHeaders },
      requestBody: {
        required: true,
        content: { 'application/x-ndjson': { schema: ndjsonRef.Message } },
      },
      responses: {
        200: {
          description: 'NDJSON stream of write result messages',
          content: { 'application/x-ndjson': { schema: ndjsonRef.DestinationOutput } },
        },
        400: errorResponse,
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (c: any) => {
      const pipeline = c.req.valid('header')['x-pipeline']
      const context = { path: '/pipeline_write', ...syncRequestContext(pipeline) }
      if (!hasBody(c)) {
        logger.error(context, 'Engine API /write missing request body')
        return c.json({ error: 'Request body required for /write' }, 400)
      }
      const startedAt = Date.now()
      logger.info(context, 'Engine API /write started')
      const messages = parseNdjsonStream<Message>(c.req.raw.body!)
      return ndjsonResponse(
        logApiStream(
          'Engine API /write',
          engine.pipeline_write(pipeline, messages),
          context,
          startedAt
        )
      )
    }) as any
  )

  app.openapi(
    createRoute({
      operationId: 'pipeline_sync',
      method: 'post',
      path: '/pipeline_sync',
      tags: ['Stateless Sync API'],
      summary: 'Run sync pipeline (read → write)',
      description:
        'Without a request body, reads from the source connector and writes to the destination (backfill mode). ' +
        'With an NDJSON request body, uses the provided messages as input instead of reading from the source (push mode — e.g. piped webhook events).',
      requestParams: { header: allSyncHeaders, query: syncQueryParams },
      requestBody: {
        required: false,
        content: {
          'application/x-ndjson': {
            schema: SourceInput ? ndjsonRef.SourceInput : ndjsonRef.Message,
          },
        },
      },
      responses: {
        200: {
          description: 'NDJSON stream of sync messages',
          content: { 'application/x-ndjson': { schema: ndjsonRef.DestinationOutput } },
        },
        400: errorResponse,
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (c: any) => {
      const pipeline = c.req.valid('header')['x-pipeline']
      const state = c.req.valid('header')['x-state'] as Record<string, unknown> | undefined
      const { state_limit: stateLimit, time_limit: timeLimit } = c.req.valid('query')
      const input = hasBody(c) ? parseNdjsonStream(c.req.raw.body!) : undefined
      const output = engine.pipeline_sync(pipeline, { state, stateLimit, timeLimit }, input)
      return ndjsonResponse(output)
    }) as any
  )

  app.openapi(
    createRoute({
      operationId: 'meta_sources_list',
      method: 'get',
      path: '/meta/sources',
      tags: ['Meta'],
      summary: 'List available source connectors',
      responses: {
        200: {
          description: 'Available source connectors with their JSON Schema configs',
          content: {
            'application/json': {
              schema: z.object({ items: z.array(ConnectorListItem) }),
            },
          },
        },
      },
    }),
    async (c) => {
      return c.json(await engine.meta_sources_list(), 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'meta_sources_get',
      method: 'get',
      path: '/meta/sources/{type}',
      tags: ['Meta'],
      summary: 'Get source connector spec',
      requestParams: { path: z.object({ type: z.string() }) },
      responses: {
        200: {
          description: 'Source connector spec',
          content: { 'application/json': { schema: ConnectorInfo } },
        },
        404: { description: 'Source connector not found' },
      },
    }),
    async (c) => {
      const { type } = c.req.valid('param')
      try {
        return c.json(await engine.meta_sources_get(type), 200)
      } catch {
        return c.json({ error: `Unknown source connector: ${type}` }, 404)
      }
    }
  )

  app.openapi(
    createRoute({
      operationId: 'meta_destinations_list',
      method: 'get',
      path: '/meta/destinations',
      tags: ['Meta'],
      summary: 'List available destination connectors',
      responses: {
        200: {
          description: 'Available destination connectors with their JSON Schema configs',
          content: {
            'application/json': {
              schema: z.object({ items: z.array(ConnectorListItem) }),
            },
          },
        },
      },
    }),
    async (c) => {
      return c.json(await engine.meta_destinations_list(), 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'meta_destinations_get',
      method: 'get',
      path: '/meta/destinations/{type}',
      tags: ['Meta'],
      summary: 'Get destination connector spec',
      requestParams: { path: z.object({ type: z.string() }) },
      responses: {
        200: {
          description: 'Destination connector spec',
          content: { 'application/json': { schema: ConnectorInfo } },
        },
        404: { description: 'Destination connector not found' },
      },
    }),
    async (c) => {
      const { type } = c.req.valid('param')
      try {
        return c.json(await engine.meta_destinations_get(type), 200)
      } catch {
        return c.json({ error: `Unknown destination connector: ${type}` }, 404)
      }
    }
  )

  // ── OpenAPI spec + Swagger UI ───────────────────────────────────

  app.get('/openapi.json', (c) => {
    const spec = app.getOpenAPI31Document({
      info: {
        title: 'Stripe Sync Engine',
        version: '1.0.0',
        description:
          'Stripe Sync Engine — stateless, one-shot source/destination sync over HTTP.\nAll sync endpoints accept configuration via the `X-Pipeline` header (JSON-encoded PipelineConfig). Optional cursor state can be provided via `X-State`.',
      },
      // Register NDJSON message schemas as components (used via raw $ref in routes
      // to avoid zod-openapi generating *Output duplicates for dual-use schemas).
      components: {
        schemas: {
          Message: MessageSchema,
          DiscoverOutput: DiscoverOutputSchema,
          DestinationOutput: DestinationOutputSchema,
          ...(SourceInput ? { SourceInput } : {}),
        },
      },
    }) as any

    spec.info.description += '\n\n## Endpoints\n\n' + endpointTable(spec)
    return c.json(spec)
  })

  app.get('/docs', apiReference({ url: '/openapi.json' }))

  // ── Internal utilities ───────────────────────────────────────────────────────
  // NOTE: no HTTP auth on /internal/* — only safe on a trusted private network.

  app.post('/internal/query', async (c) => {
    const { connection_string, sql } = await c.req.json<{
      connection_string: string
      sql: string
    }>()
    const pool = new pg.Pool(
      withPgConnectProxy({
        connectionString: stripSslParams(connection_string),
        ssl: sslConfigFromConnectionString(connection_string),
      })
    )
    try {
      const result = await pool.query(sql)
      return c.json({ rows: result.rows, rowCount: result.rowCount })
    } finally {
      await pool.end()
    }
  })

  return app
}
