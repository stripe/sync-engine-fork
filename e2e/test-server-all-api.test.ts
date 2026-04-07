import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import pg from 'pg'
import {
  applyCreatedTimestampRange,
  createStripeListServer,
  ensureObjectTable,
  generateStubObjects,
  quoteIdentifier,
  resolveEndpointSet,
  startDockerPostgres18,
  upsertObjects,
  type DockerPostgres18Handle,
  type StripeListServer,
} from '@stripe/sync-test-utils'
import { createConnectorResolver, createEngine, type PipelineConfig } from '@stripe/sync-engine'
import { SUPPORTED_API_VERSIONS, resolveOpenApiSpec } from '@stripe/sync-openapi'
import destinationPostgres from '@stripe/sync-destination-postgres'
import sourceStripe, { type StripeStreamState } from '@stripe/sync-source-stripe'
import { ensureStripeMock, STRIPE_MOCK_URL, utc } from './test-server-harness.js'

const SOURCE_SCHEMA = 'stripe'
const SEED_BATCH = 12000
const OBJECTS_PER_STREAM = 1200
const RATE_LIMIT = 10000

const RANGE_START = utc('2025-01-01')
const RANGE_END = utc('2026-01-01')

let sourceDocker: DockerPostgres18Handle
let destDocker: DockerPostgres18Handle
let testServer: StripeListServer
let sourcePool: pg.Pool
let destPool: pg.Pool
let customerTemplate: Record<string, unknown>
const specPathByVersion = new Map<string, string>()
let githubToken: string | null | undefined

type StreamSeed = {
  tableName: string
  objectIds: string[]
}

async function fetchTemplates(endpoint: string): Promise<Record<string, unknown>[]> {
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

async function replaceTableObjects(
  tableName: string,
  objects: Record<string, unknown>[]
): Promise<void> {
  await ensureObjectTable(sourcePool, SOURCE_SCHEMA, tableName)
  await sourcePool.query(
    `TRUNCATE TABLE ${quoteIdentifier(SOURCE_SCHEMA)}.${quoteIdentifier(tableName)}`
  )

  for (let i = 0; i < objects.length; i += SEED_BATCH) {
    await upsertObjects(sourcePool, SOURCE_SCHEMA, tableName, objects.slice(i, i + SEED_BATCH))
  }
}

function makeCustomer(id: string, created: number): Record<string, unknown> {
  return {
    ...customerTemplate,
    id,
    object: 'customer',
    created,
  }
}

function schemaForVersion(apiVersion: string): string {
  const safeVersion = apiVersion.toLowerCase().replace(/[^a-z0-9]+/g, '_')
  return `all_api_${safeVersion}_${Date.now()}`
}

function getGithubToken(): string | null {
  if (githubToken !== undefined) return githubToken

  try {
    const token = execSync('gh auth token', {
      cwd: new URL('..', import.meta.url).pathname,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim()
    githubToken = token.length > 0 ? token : null
  } catch {
    githubToken = null
  }

  return githubToken
}

async function specFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const token = getGithubToken()

  if (!token || !url.startsWith('https://api.github.com/')) {
    return fetch(input, init)
  }

  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('X-GitHub-Api-Version', '2022-11-28')

  return fetch(input, { ...init, headers })
}

async function resolveSpecPath(apiVersion: string): Promise<string> {
  const cached = specPathByVersion.get(apiVersion)
  if (cached) return cached

  const resolved = await resolveOpenApiSpec({ apiVersion }, specFetch)
  if (!resolved.cachePath) {
    throw new Error(`No cache path returned for Stripe API version ${apiVersion}`)
  }

  specPathByVersion.set(apiVersion, resolved.cachePath)
  return resolved.cachePath
}

async function syncAllEndpointsForVersion(apiVersion: string): Promise<void> {
  const createdRange = { startUnix: RANGE_START, endUnix: RANGE_END }
  const openApiSpecPath = await resolveSpecPath(apiVersion)
  const endpointSet = await resolveEndpointSet({
    apiVersion,
    openApiSpecPath,
    fetchImpl: specFetch,
  })
  const sortedEndpoints = [...endpointSet.endpoints.values()].sort((a, b) =>
    a.tableName.localeCompare(b.tableName)
  )
  const seededStreams: StreamSeed[] = []
  const destSchema = schemaForVersion(apiVersion)
  const versionTestServer = await createStripeListServer({
    postgresUrl: sourceDocker.connectionString,
    host: '127.0.0.1',
    port: 0,
    accountCreated: 0,
    logRequests: false,
    validateQueryParams: true,
    apiVersion,
    openApiSpecPath,
    fetchImpl: specFetch,
  })

  expect(sortedEndpoints.length, `${apiVersion} should expose at least one stream`).toBeGreaterThan(
    0
  )

  try {
    for (const endpoint of sortedEndpoints) {
      const objects = applyCreatedTimestampRange(
        generateStubObjects(endpoint, OBJECTS_PER_STREAM),
        createdRange
      )

      await replaceTableObjects(endpoint.tableName, objects)
      seededStreams.push({
        tableName: endpoint.tableName,
        objectIds: objects.map((object: Record<string, unknown>) => object.id as string),
      })
    }

    const pipeline: PipelineConfig = {
      source: {
        type: 'stripe',
        stripe: {
          api_key: 'sk_test_fake',
          api_version: endpointSet.apiVersion,
          base_url: versionTestServer.url,
          rate_limit: RATE_LIMIT,
          backfill_concurrency: 5,
        },
      },
      destination: {
        type: 'postgres',
        postgres: {
          connection_string: destDocker.connectionString,
          schema: destSchema,
          batch_size: 100,
        },
      },
      streams: seededStreams.map((stream) => ({
        name: stream.tableName,
        sync_mode: 'full_refresh',
      })),
    }

    const resolver = await createConnectorResolver({
      sources: { stripe: sourceStripe },
      destinations: { postgres: destinationPostgres },
    })
    const engine = await createEngine(resolver)
    const finalState: Record<string, unknown> = {}

    for await (const setupMsg of engine.pipeline_setup(pipeline)) {
      void setupMsg
    }

    for await (const msg of engine.pipeline_sync(pipeline)) {
      if (msg.type === 'source_state' && msg.source_state.state_type === 'stream') {
        finalState[msg.source_state.stream] = msg.source_state.data
      }
    }

    const failures: string[] = []
    const syncedCounts: string[] = []

    for (const seed of seededStreams) {
      const { rows } = await destPool.query<{ id: string }>(
        `SELECT id FROM ${quoteIdentifier(destSchema)}.${quoteIdentifier(seed.tableName)} ORDER BY id`
      )

      syncedCounts.push(
        `    ${seed.tableName}: ${rows.length} synced (${seed.objectIds.length} seeded)`
      )

      const destIds = new Set(rows.map((row) => row.id))
      const expectedIds = new Set(seed.objectIds)
      const missing = [...expectedIds].filter((id) => !destIds.has(id))
      const unexpected = [...destIds].filter((id) => !expectedIds.has(id))

      if (missing.length > 0) {
        failures.push(
          `${apiVersion}/${seed.tableName}: missing ${missing.length} objects (first 5: ${missing.slice(0, 5).join(', ')})`
        )
      }
      if (unexpected.length > 0) {
        failures.push(
          `${apiVersion}/${seed.tableName}: unexpected ${unexpected.length} objects (first 5: ${unexpected.slice(0, 5).join(', ')})`
        )
      }
      if (rows.length !== seed.objectIds.length) {
        failures.push(
          `${apiVersion}/${seed.tableName}: expected ${seed.objectIds.length} rows, got ${rows.length}`
        )
      }

      const streamState = finalState[seed.tableName] as StripeStreamState | undefined
      if (streamState?.status !== 'complete') {
        failures.push(
          `${apiVersion}/${seed.tableName}: final state was ${streamState?.status ?? 'missing'}`
        )
      }
    }

    console.log(
      `\n  [${apiVersion}] ${seededStreams.length} streams:\n${syncedCounts.join('\n')}\n`
    )

    expect(failures, failures.join('\n')).toHaveLength(0)
  } finally {
    await destPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(destSchema)} CASCADE`)
    await versionTestServer.close().catch(() => {})
  }
}

describe('test-server API', () => {
  beforeAll(async () => {
    await ensureStripeMock()

    const [src, dest, customerTemplates] = await Promise.all([
      startDockerPostgres18(),
      startDockerPostgres18(),
      fetchTemplates('/v1/customers'),
    ])

    sourceDocker = src
    destDocker = dest
    customerTemplate = customerTemplates[0] ?? {
      object: 'customer',
      livemode: false,
      metadata: {},
      created: RANGE_START,
    }

    sourcePool = new pg.Pool({ connectionString: sourceDocker.connectionString })
    destPool = new pg.Pool({ connectionString: destDocker.connectionString })
    sourcePool.on('error', () => {})
    destPool.on('error', () => {})

    testServer = await createStripeListServer({
      postgresUrl: sourceDocker.connectionString,
      host: '127.0.0.1',
      port: 0,
      accountCreated: RANGE_START,
      logRequests: false,
      validateQueryParams: true,
    })
  }, 10 * 60_000)

  afterAll(async () => {
    await testServer?.close().catch(() => {})
    await sourcePool?.end().catch(() => {})
    await destPool?.end().catch(() => {})
    await destDocker?.stop()
    await sourceDocker?.stop()
  }, 60_000)

  it('retrieve returns object by ID, 404 for missing', async () => {
    await replaceTableObjects('customers', [makeCustomer('cus_ret_1', RANGE_START + 100)])

    const okRes = await fetch(`${testServer.url}/v1/customers/cus_ret_1`, {
      headers: { Authorization: 'Bearer sk_test_fake' },
    })
    expect(okRes.status).toBe(200)
    const body = (await okRes.json()) as Record<string, unknown>
    expect(body.id).toBe('cus_ret_1')
    expect(body.object).toBe('customer')

    const missingRes = await fetch(`${testServer.url}/v1/customers/cus_nonexistent`, {
      headers: { Authorization: 'Bearer sk_test_fake' },
    })
    expect(missingRes.status).toBe(404)
    const errBody = (await missingRes.json()) as { error: { code: string } }
    expect(errBody.error.code).toBe('resource_missing')
  }, 120_000)

  it('unrecognized path returns 404, non-GET returns 405', async () => {
    await replaceTableObjects('customers', [])

    const notFoundRes = await fetch(`${testServer.url}/v1/totally_fake_endpoint`, {
      headers: { Authorization: 'Bearer sk_test_fake' },
    })
    expect(notFoundRes.status).toBe(404)
    const errBody = (await notFoundRes.json()) as { error: { type: string } }
    expect(errBody.error.type).toBe('invalid_request_error')

    const methodRes = await fetch(`${testServer.url}/v1/customers`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sk_test_fake' },
    })
    expect(methodRes.status).toBe(405)
  }, 120_000)

  it('list request with invalid query params fails', async () => {
    const validatingServer = await createStripeListServer({
      postgresUrl: sourceDocker.connectionString,
      host: '127.0.0.1',
      port: 0,
      accountCreated: RANGE_START,
      logRequests: false,
      validateQueryParams: true,
    })
    try {
      const res = await fetch(`${validatingServer.url}/v1/customers?foo=bar`, {
        headers: { Authorization: 'Bearer sk_test_fake' },
      })
      expect(res.status).toBe(400)
      const errBody = (await res.json()) as {
        error: { type: string; message: string; details: string[]; allowed: string[] }
      }
      expect(errBody.error.type).toBe('invalid_request_error')
      expect(errBody.error.message).toBe('Query parameters do not match OpenAPI definition')
      expect(errBody.error.details).toContain('Unknown query parameter "foo"')
      expect(errBody.error.allowed).toContain('limit')
    } finally {
      await validatingServer.close().catch(() => {})
    }
  }, 120_000)

  for (const supportedApiVersion of SUPPORTED_API_VERSIONS) {
    it(
      `syncs all supported streams for Stripe API ${supportedApiVersion}`,
      async () => {
        await syncAllEndpointsForVersion(supportedApiVersion)
      },
      3 * 60_000
    )
  }
})
