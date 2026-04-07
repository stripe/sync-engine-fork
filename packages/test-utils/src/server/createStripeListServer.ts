import { Hono } from 'hono'
import type { Context } from 'hono'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import pg from 'pg'
import { DEFAULT_STORAGE_SCHEMA, ensureSchema, quoteIdentifier } from '../db/storage.js'
import { resolveEndpointSet, type EndpointDefinition } from '../openapi/endpoints.js'
import { startDockerPostgres18, type DockerPostgres18Handle } from '../postgres/dockerPostgres18.js'
import type {
  StripeListServerOptions,
  StripeListServer,
  StripeListServerAuthOptions,
  StripeListServerFailureRule,
  PageResult,
  V1PageQuery,
  V2PageQuery,
} from './types.js'
import { seedCustomersForStripeListServer } from './seedCustomers.js'

export type { StripeListServerOptions, StripeListServer } from './types.js'

// ── Helpers ───────────────────────────────────────────────────────

function makeFakeAccount(created: number) {
  return {
    id: 'acct_test_fake_000000',
    object: 'account',
    type: 'standard',
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    business_type: 'company',
    country: 'US',
    default_currency: 'usd',
    email: 'test@example.com',
    created,
    settings: { dashboard: { display_name: 'Test Account' } },
  }
}

// ── Server factory ────────────────────────────────────────────────

export async function createStripeListServer(
  options: StripeListServerOptions = {}
): Promise<StripeListServer> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const schema = options.schema ?? DEFAULT_STORAGE_SCHEMA
  const endpointSet = await resolveEndpointSet({
    apiVersion: options.apiVersion,
    openApiSpecPath: options.openApiSpecPath,
    fetchImpl,
  })

  let dockerHandle: DockerPostgres18Handle | undefined
  let postgresMode: 'docker' | 'external' = 'external'
  const postgresUrl = options.postgresUrl ?? process.env.POSTGRES_URL
  if (!postgresUrl) {
    dockerHandle = await startDockerPostgres18()
    postgresMode = 'docker'
  }
  const connectionString = postgresUrl ?? dockerHandle?.connectionString
  if (!connectionString) {
    throw new Error('No Postgres connection string available')
  }

  const pool = new pg.Pool({ connectionString })
  await ensureSchema(pool, schema)

  let seededCustomerIds: string[] | undefined
  if (options.seedCustomers) {
    seededCustomerIds = await seedCustomersForStripeListServer(
      pool,
      schema,
      options.seedCustomers,
      fetchImpl
    )
  }

  const fakeAccount = makeFakeAccount(options.accountCreated ?? Math.floor(Date.now() / 1000))
  const failureStates = (options.failures ?? []).map(() => ({ matches: 0, failures: 0 }))

  // ── Build Hono app ────────────────────────────────────────────

  const app = new Hono()

  app.use('*', async (c, next) => {
    await next()
    logRequest(c.req.method, c.req.path, c.res.status)
  })

  for (const prefix of ['/v1/*', '/v2/*'] as const) {
    app.use(prefix, async (c, next) => {
      const intercepted = maybeInterceptStripeApiRequest(
        c,
        options.auth,
        options.failures ?? [],
        failureStates
      )
      if (intercepted) return intercepted
      await next()
    })
  }

  app.get('/health', (c) =>
    c.json({
      ok: true,
      api_version: endpointSet.apiVersion,
      endpoint_count: endpointSet.endpoints.size,
    })
  )

  app.get('/db-health', async (c) => {
    const probe = await pool.query('SELECT 1 AS ok')
    return c.json({
      ok: probe.rows[0]?.ok === 1,
      postgres_mode: postgresMode,
      postgres_url: redactConnectionString(connectionString),
      schema,
    })
  })

  app.get('/v1/account', (c) => c.json(fakeAccount))

  for (const ep of endpointSet.endpoints.values()) {
    app.get(ep.apiPath, (c) => handleList(c, pool, schema, ep))
    app.get(`${ep.apiPath}/:id`, (c) => handleRetrieve(c, pool, schema, ep, c.req.param('id')))
  }

  for (const prefix of ['/v1/*', '/v2/*'] as const) {
    app.all(prefix, (c) => {
      if (c.req.method !== 'GET') {
        return c.json(
          { error: { type: 'invalid_request_error', message: 'Method not allowed' } },
          405
        )
      }
      return c.json(
        {
          error: {
            type: 'invalid_request_error',
            message: `Unrecognized request URL (GET: ${c.req.path})`,
          },
        },
        404
      )
    })
  }

  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  })

  // ── Start server ──────────────────────────────────────────────

  const serverHost = options.host ?? '127.0.0.1'
  const serverPort = options.port ?? 5555

  let nodeServer: ServerType | undefined
  await new Promise<void>((resolve, reject) => {
    try {
      nodeServer = serve({ fetch: app.fetch, port: serverPort, hostname: serverHost }, () =>
        resolve()
      )
    } catch (err) {
      reject(err)
    }
  })

  const addr = nodeServer!.address()
  const actualPort = typeof addr === 'object' && addr ? addr.port : serverPort

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (nodeServer) {
      await new Promise<void>((resolve) => {
        nodeServer!.close(() => resolve())
      })
    }
    await pool.end().catch(() => undefined)
    if (dockerHandle) await dockerHandle.stop()
  }

  const cleanup = () => {
    void close()
  }
  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)

  return {
    host: serverHost,
    port: actualPort,
    url: `http://${serverHost}:${actualPort}`,
    postgresUrl: connectionString,
    postgresMode,
    close,
    ...(seededCustomerIds != null ? { seededCustomerIds } : {}),
  }
}

// ---------------------------------------------------------------------------
// List — paginated read from Postgres, returns Stripe list response format
// ---------------------------------------------------------------------------

async function handleList(
  c: Context,
  pool: pg.Pool,
  schema: string,
  endpoint: EndpointDefinition
): Promise<Response> {
  if (endpoint.isV2) {
    const limit = clampLimit(c.req.query('limit'), 20)
    const pageToken = c.req.query('page')
    const afterId = pageToken ? decodePageToken(pageToken) : undefined

    const { data, hasMore, lastId } = await queryPageV2(pool, schema, endpoint.tableName, {
      limit,
      afterId,
    })

    const nextPageUrl =
      hasMore && lastId
        ? buildV2NextPageUrl(
            endpoint.apiPath,
            limit,
            encodePageToken(lastId),
            new URL(c.req.url).searchParams
          )
        : null

    return c.json({
      data,
      next_page_url: nextPageUrl,
      previous_page_url: null,
    })
  }

  const limit = clampLimit(c.req.query('limit'), 10)
  const { data, hasMore } = await queryPageV1(pool, schema, endpoint.tableName, {
    limit,
    afterId: c.req.query('starting_after'),
    beforeId: c.req.query('ending_before'),
    createdGt: parseIntParam(c.req.query('created[gt]')),
    createdGte: parseIntParam(c.req.query('created[gte]')),
    createdLt: parseIntParam(c.req.query('created[lt]')),
    createdLte: parseIntParam(c.req.query('created[lte]')),
  })

  return c.json({
    object: 'list',
    url: endpoint.apiPath,
    has_more: hasMore,
    data,
  })
}

// ---------------------------------------------------------------------------
// Retrieve — single object by ID from Postgres
// ---------------------------------------------------------------------------

async function handleRetrieve(
  c: Context,
  pool: pg.Pool,
  schema: string,
  endpoint: EndpointDefinition,
  objectId: string
): Promise<Response> {
  let rows: { _raw_data: Record<string, unknown> }[]
  try {
    const result = await pool.query(
      `SELECT _raw_data FROM ${quoteIdentifier(schema)}.${quoteIdentifier(endpoint.tableName)} WHERE id = $1 LIMIT 1`,
      [objectId]
    )
    rows = result.rows
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '42P01') {
      rows = []
    } else {
      throw err
    }
  }

  if (rows.length === 0) {
    return c.json(
      {
        error: {
          type: 'invalid_request_error',
          message: `No such ${endpoint.resourceId}: '${objectId}'`,
          param: 'id',
          code: 'resource_missing',
        },
      },
      404
    )
  }

  return c.json(rows[0]._raw_data as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// Postgres queries — paginated reads from seeded tables
// ---------------------------------------------------------------------------

async function resolveCursorCreated(
  pool: pg.Pool,
  schema: string,
  tableName: string,
  cursorId: string
): Promise<number | undefined> {
  const result = await pool.query<{ created: string }>(
    `SELECT created FROM ${quoteIdentifier(schema)}.${quoteIdentifier(tableName)} WHERE id = $1`,
    [cursorId]
  )
  return result.rows.length > 0 ? Number(result.rows[0].created) : undefined
}

/**
 * V1: created DESC, id DESC; tuple cursors for starting_after / ending_before.
 */
async function queryPageV1(
  pool: pg.Pool,
  schema: string,
  tableName: string,
  opts: V1PageQuery
): Promise<PageResult> {
  const conditions: string[] = []
  const values: unknown[] = []
  let idx = 0
  const useEndingBefore = !opts.afterId && !!opts.beforeId

  if (opts.afterId) {
    const cursorCreated = await resolveCursorCreated(pool, schema, tableName, opts.afterId)
    if (cursorCreated == null) return { data: [], hasMore: false }
    conditions.push(`(created, id) < ($${++idx}::bigint, $${++idx})`)
    values.push(cursorCreated, opts.afterId)
  }
  if (opts.beforeId) {
    const cursorCreated = await resolveCursorCreated(pool, schema, tableName, opts.beforeId)
    if (cursorCreated == null) return { data: [], hasMore: false }
    conditions.push(`(created, id) > ($${++idx}::bigint, $${++idx})`)
    values.push(cursorCreated, opts.beforeId)
  }
  if (opts.createdGt != null) {
    conditions.push(`created > $${++idx}`)
    values.push(opts.createdGt)
  }
  if (opts.createdGte != null) {
    conditions.push(`created >= $${++idx}`)
    values.push(opts.createdGte)
  }
  if (opts.createdLt != null) {
    conditions.push(`created < $${++idx}`)
    values.push(opts.createdLt)
  }
  if (opts.createdLte != null) {
    conditions.push(`created <= $${++idx}`)
    values.push(opts.createdLte)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const fetchLimit = opts.limit + 1
  values.push(fetchLimit)

  const orderDir = useEndingBefore ? 'ASC' : 'DESC'
  const orderClause = `ORDER BY created ${orderDir}, id ${orderDir}`
  const table = `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`

  const rows = await safeQuery(
    pool,
    `SELECT _raw_data FROM ${table} ${where} ${orderClause} LIMIT $${++idx}`,
    values,
    tableName
  )

  const hasMore = rows.length > opts.limit
  const page = rows.slice(0, opts.limit)
  if (useEndingBefore) page.reverse()

  const data = page.map((r) => r._raw_data)
  const lastId = data.length > 0 ? (data[data.length - 1].id as string) : undefined
  return { data, hasMore, lastId }
}

/**
 * V2: opaque page tokens map to id ASC + `id > cursor` (no created ordering).
 */
async function queryPageV2(
  pool: pg.Pool,
  schema: string,
  tableName: string,
  opts: V2PageQuery
): Promise<PageResult> {
  const conditions: string[] = []
  const values: unknown[] = []
  let idx = 0

  if (opts.afterId) {
    conditions.push(`id > $${++idx}`)
    values.push(opts.afterId)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const fetchLimit = opts.limit + 1
  values.push(fetchLimit)

  const table = `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`
  const rows = await safeQuery(
    pool,
    `SELECT _raw_data FROM ${table} ${where} ORDER BY id ASC LIMIT $${++idx}`,
    values,
    tableName
  )

  const hasMore = rows.length > opts.limit
  const page = rows.slice(0, opts.limit)
  const data = page.map((r) => r._raw_data)
  const lastId = data.length > 0 ? (data[data.length - 1].id as string) : undefined
  return { data, hasMore, lastId }
}

async function safeQuery(
  pool: pg.Pool,
  sql: string,
  values: unknown[],
  tableName: string
): Promise<{ _raw_data: Record<string, unknown> }[]> {
  try {
    const result = await pool.query(sql, values)
    return result.rows
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '42P01') {
      process.stderr.write(
        `[sync-test-utils] WARNING: table "${tableName}" does not exist — returning empty result. Was the database seeded?\n`
      )
      return []
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clampLimit(raw: string | undefined, defaultLimit: number): number {
  if (raw == null) return defaultLimit
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return defaultLimit
  return Math.min(n, 100)
}

function parseIntParam(raw: string | undefined): number | undefined {
  if (raw == null) return undefined
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : undefined
}

function encodePageToken(id: string): string {
  return Buffer.from(id).toString('base64url')
}

function decodePageToken(token: string): string {
  return Buffer.from(token, 'base64url').toString()
}

/** Carry forward expand / expand[] (and similar) on v2 next_page_url. */
function buildV2NextPageUrl(
  apiPath: string,
  limit: number,
  pageToken: string,
  incoming: URLSearchParams
): string {
  const qs = new URLSearchParams()
  qs.set('limit', String(limit))
  qs.set('page', pageToken)
  for (const [key, value] of incoming.entries()) {
    if (key === 'limit' || key === 'page') continue
    if (key.startsWith('expand')) qs.append(key, value)
  }
  return `${apiPath}?${qs.toString()}`
}

function logRequest(method: string, path: string, statusCode: number): void {
  process.stderr.write(`[sync-test-utils] ${method} ${path} → ${statusCode}\n`)
}

function redactConnectionString(connectionString: string): string {
  try {
    const parsed = new URL(connectionString)
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return connectionString
  }
}

function maybeInterceptStripeApiRequest(
  c: Context,
  auth: StripeListServerAuthOptions | undefined,
  failures: StripeListServerFailureRule[],
  failureStates: Array<{ matches: number; failures: number }>
): Response | undefined {
  const authFailure = maybeHandleAuthFailure(c, auth)
  if (authFailure) return authFailure

  return maybeHandleInjectedFailure(c, failures, failureStates)
}

function maybeHandleAuthFailure(
  c: Context,
  auth: StripeListServerAuthOptions | undefined
): Response | undefined {
  if (!auth) return undefined
  const protectedPaths = auth.protectedPaths ?? ['/v1/*', '/v2/*']
  if (!pathMatchesAny(c.req.path, protectedPaths)) return undefined

  const bearerToken = extractBearerToken(c.req.header('authorization'))
  if (bearerToken === auth.expectedBearerToken) return undefined

  return c.json(
    {
      error: {
        type: 'invalid_request_error',
        message:
          auth.errorMessage ??
          (bearerToken ? `Invalid API Key provided: ${bearerToken}` : 'Invalid API Key provided'),
      },
    },
    401
  )
}

function maybeHandleInjectedFailure(
  c: Context,
  failures: StripeListServerFailureRule[],
  failureStates: Array<{ matches: number; failures: number }>
): Response | undefined {
  for (const [index, rule] of failures.entries()) {
    if (!matchesFailureRule(c.req.method, c.req.path, rule)) continue

    const state = failureStates[index]!
    state.matches += 1

    const after = rule.after ?? 0
    const times = rule.times ?? Number.POSITIVE_INFINITY
    if (state.matches <= after || state.failures >= times) continue

    state.failures += 1
    return new Response(JSON.stringify(buildFailureBody(rule, c.req.method, c.req.path)), {
      status: rule.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return undefined
}

function matchesFailureRule(
  method: string,
  path: string,
  rule: StripeListServerFailureRule
): boolean {
  const expectedMethod = (rule.method ?? 'GET').toUpperCase()
  if (method.toUpperCase() !== expectedMethod) return false
  return matchesPathPattern(path, rule.path)
}

function buildFailureBody(
  rule: StripeListServerFailureRule,
  method: string,
  path: string
): Record<string, unknown> {
  if (rule.body) return rule.body
  if (rule.stripeError) {
    return {
      error: {
        type: rule.stripeError.type ?? 'api_error',
        message: rule.stripeError.message,
        ...(rule.stripeError.code ? { code: rule.stripeError.code } : {}),
      },
    }
  }
  return {
    error: {
      type: 'api_error',
      message: `Injected failure for ${method.toUpperCase()} ${path}`,
    },
  }
}

function pathMatchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPathPattern(path, pattern))
}

function matchesPathPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return path.startsWith(pattern.slice(0, -1))
  }
  return path === pattern
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1] ?? null
}
