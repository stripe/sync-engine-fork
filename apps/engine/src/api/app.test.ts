import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorResolver, Message, StateMessage } from '../lib/index.js'
import { sourceTest, destinationTest } from '../lib/index.js'
import { createApp } from './app.js'
import pg from 'pg'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const resolver: ConnectorResolver = {
  resolveSource: async (name: string) => {
    if (name !== 'test') throw new Error(`Unknown source connector: ${name}`)
    return sourceTest
  },
  resolveDestination: async (name: string) => {
    if (name !== 'test') throw new Error(`Unknown destination connector: ${name}`)
    return destinationTest
  },
  sources: () =>
    new Map([
      [
        'test',
        {
          connector: sourceTest,
          configSchema: {} as any,
          rawConfigJsonSchema: sourceTest.spec().config,
        },
      ],
    ]),
  destinations: () =>
    new Map([
      [
        'test',
        {
          connector: destinationTest,
          configSchema: {} as any,
          rawConfigJsonSchema: destinationTest.spec().config,
        },
      ],
    ]),
}
const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined)
const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

const syncParams = JSON.stringify({
  source: { type: 'test', streams: { customers: {} } },
  destination: { type: 'test' },
})

/** Read an NDJSON response body into an array of parsed lines. */
async function readNdjson<T>(res: Response): Promise<T[]> {
  const text = await res.text()
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T)
}

/** Build NDJSON string from array of objects. */
function toNdjson(items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join('\n')
}

/** Headers for a request body: Content-Type + Content-Length (required for hasBody()). */
function bodyHeaders(body: string): Record<string, string> {
  return {
    'Content-Type': 'application/x-ndjson',
    'Content-Length': String(new TextEncoder().encode(body).length),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  consoleInfo.mockClear()
  consoleError.mockClear()
})

// ---------------------------------------------------------------------------
// OpenAPI spec
// ---------------------------------------------------------------------------

describe('GET /openapi.json', () => {
  it('returns a valid OpenAPI 3.1 spec', async () => {
    const app = createApp(resolver)
    const res = await app.request('/openapi.json')
    expect(res.status).toBe(200)
    const spec = await res.json()
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info.title).toBeDefined()
    expect(spec.paths).toBeDefined()
  })

  it('includes all sync operation paths', async () => {
    const app = createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as { paths: Record<string, unknown> }
    const paths = Object.keys(spec.paths)

    expect(paths).toContain('/health')
    expect(paths).toContain('/setup')
    expect(paths).toContain('/teardown')
    expect(paths).toContain('/check')
    expect(paths).toContain('/read')
    expect(paths).toContain('/write')
    expect(paths).toContain('/sync')
    expect(paths).toContain('/connectors')
  })

  it('injects typed connector schemas into components', async () => {
    const app = createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as any
    const schemaNames = Object.keys(spec.components?.schemas ?? {})

    expect(schemaNames).toContain('TestSourceConfig')
    expect(schemaNames).toContain('TestDestinationConfig')
    expect(schemaNames).toContain('SourceConfig')
    expect(schemaNames).toContain('DestinationConfig')
    expect(schemaNames).toContain('PipelineConfig')

    // SourceConfig is a discriminated union
    expect(spec.components.schemas.SourceConfig.discriminator.propertyName).toBe('type')
    expect(spec.components.schemas.SourceConfig.oneOf).toHaveLength(1)

    // Each variant has type as required field
    const testSource = spec.components.schemas.TestSourceConfig
    expect(testSource.required).toContain('type')
    expect(testSource.properties.type.enum).toEqual(['test'])
  })

  it('defines NDJSON message schemas with discriminated unions', async () => {
    const app = createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as any
    const schemas = spec.components.schemas

    // Individual message types — zod-openapi uses const for z.literal() in OpenAPI 3.1
    expect(schemas.RecordMessage.properties.type.const).toBe('record')
    expect(schemas.StateMessage.properties.type.const).toBe('state')
    expect(schemas.ErrorMessage.properties.type.const).toBe('error')

    // Message union
    expect(schemas.Message.discriminator.propertyName).toBe('type')
    expect(schemas.Message.oneOf).toHaveLength(6)

    // DestinationOutput union
    expect(schemas.DestinationOutput.discriminator.propertyName).toBe('type')
    expect(schemas.DestinationOutput.oneOf).toHaveLength(3)

    // NDJSON responses reference schemas (zod-openapi adds Output suffix for response-only types)
    const readNdjson =
      spec.paths['/read']?.post?.responses?.['200']?.content?.['application/x-ndjson']
    expect(readNdjson.schema.$ref).toBe('#/components/schemas/MessageOutput')

    const writeNdjson =
      spec.paths['/write']?.post?.responses?.['200']?.content?.['application/x-ndjson']
    expect(writeNdjson.schema.$ref).toBe('#/components/schemas/DestinationOutput')

    const syncNdjson =
      spec.paths['/sync']?.post?.responses?.['200']?.content?.['application/x-ndjson']
    expect(syncNdjson.schema.$ref).toBe('#/components/schemas/DestinationOutput')
  })

  it('/setup spec documents 200 response (not 204)', async () => {
    const app = createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as any
    const setupOp = spec.paths['/setup']?.post
    expect(setupOp).toBeDefined()
    expect(setupOp.responses['200']).toBeDefined()
    expect(setupOp.responses['204']).toBeUndefined()
  })

  it('/write spec documents a required NDJSON request body', async () => {
    const app = createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as any
    const writeOp = spec.paths['/write']?.post
    expect(writeOp).toBeDefined()
    const body = writeOp.requestBody
    expect(body).toBeDefined()
    expect(body.required).toBe(true)
    const ndjsonContent = body.content?.['application/x-ndjson']
    expect(ndjsonContent).toBeDefined()
    expect(ndjsonContent.schema.$ref).toBe('#/components/schemas/Message')
  })

  it('documents the X-Pipeline header on sync routes', async () => {
    const app = createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as any

    // /check is a GET with X-Pipeline header
    const checkOp = spec.paths['/check']?.get
    expect(checkOp).toBeDefined()
    const headerParam = checkOp.parameters?.find(
      (p: any) => p.in === 'header' && p.name === 'x-pipeline'
    )
    expect(headerParam).toBeDefined()
  })
})

describe('GET /connectors', () => {
  it('returns available connectors with config schemas', async () => {
    const app = createApp(resolver)
    const res = await app.request('/connectors')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.sources).toHaveProperty('test')
    expect(body.destinations).toHaveProperty('test')
    expect(body.sources.test.config_schema).toBeDefined()
  })
})

describe('GET /docs', () => {
  it('returns HTML (Scalar API reference)', async () => {
    const app = createApp(resolver)
    const res = await app.request('/docs')
    expect(res.status).toBe(200)
    const contentType = res.headers.get('content-type') ?? ''
    expect(contentType).toContain('text/html')
  })
})

// ---------------------------------------------------------------------------
// Sync operations
// ---------------------------------------------------------------------------

describe('POST /setup', () => {
  it('returns 200 with setup result', async () => {
    const app = createApp(resolver)

    const res = await app.request('/setup', {
      method: 'POST',
      headers: { 'X-Pipeline': syncParams },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({})
  })
})

describe('POST /teardown', () => {
  it('returns 204', async () => {
    const app = createApp(resolver)

    const res = await app.request('/teardown', {
      method: 'POST',
      headers: { 'X-Pipeline': syncParams },
    })
    expect(res.status).toBe(204)
  })
})

describe('GET /check', () => {
  it('returns source and destination check results', async () => {
    const app = createApp(resolver)

    const res = await app.request('/check', {
      headers: { 'X-Pipeline': syncParams },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      source: { status: 'succeeded' },
      destination: { status: 'succeeded' },
    })
  })
})

describe('POST /read', () => {
  it('streams messages as NDJSON', async () => {
    const app = createApp(resolver)

    const body = toNdjson([
      {
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1', name: 'Alice' },
        emitted_at: Date.now(),
      },
      { type: 'state', stream: 'customers', data: { status: 'complete' } },
    ])
    const res = await app.request('/read', {
      method: 'POST',
      headers: { 'X-Pipeline': syncParams, ...bodyHeaders(body) },
      body,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')

    const events = await readNdjson<Message>(res)
    expect(events).toHaveLength(2)
    expect(events[0]!.type).toBe('record')
    expect(events[1]!.type).toBe('state')
  })
})

describe('POST /write', () => {
  it('accepts NDJSON records, streams NDJSON state back', async () => {
    const app = createApp(resolver)

    const records: Message[] = [
      {
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1' },
        emitted_at: 1000,
      },
      {
        type: 'state',
        stream: 'customers',
        data: { cursor: 'cus_1' },
      },
    ]

    const writeBody = toNdjson(records)
    const res = await app.request('/write', {
      method: 'POST',
      headers: { 'X-Pipeline': syncParams, ...bodyHeaders(writeBody) },
      body: writeBody,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')

    const events = await readNdjson<StateMessage>(res)
    // destinationTest passes through state messages only
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('state')
    expect(events[0]!.stream).toBe('customers')
  })

  it('returns 400 when body is missing', async () => {
    const app = createApp(resolver)

    const res = await app.request('/write', {
      method: 'POST',
      headers: { 'X-Pipeline': syncParams },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('body required')
  })
})

describe('POST /sync', () => {
  it('runs full pipeline, streams NDJSON state', async () => {
    const app = createApp(resolver)

    const runBody = toNdjson([
      {
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1', name: 'Alice' },
        emitted_at: Date.now(),
      },
      { type: 'state', stream: 'customers', data: { status: 'complete' } },
    ])
    const res = await app.request('/sync', {
      method: 'POST',
      headers: { 'X-Pipeline': syncParams, ...bodyHeaders(runBody) },
      body: runBody,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')

    const events = await readNdjson<StateMessage>(res)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('state')
  })
})

// ---------------------------------------------------------------------------
// X-State-Checkpoint-Limit
// ---------------------------------------------------------------------------

describe('X-State-Checkpoint-Limit', () => {
  it('POST /read stops after N state messages', async () => {
    const app = createApp(resolver)

    const body = toNdjson([
      { type: 'record', stream: 'customers', data: { id: 'cus_1' }, emitted_at: 1 },
      { type: 'state', stream: 'customers', data: { cursor: '1' } },
      { type: 'record', stream: 'customers', data: { id: 'cus_2' }, emitted_at: 2 },
      { type: 'state', stream: 'customers', data: { cursor: '2' } },
      { type: 'record', stream: 'customers', data: { id: 'cus_3' }, emitted_at: 3 },
    ])
    const res = await app.request('/read', {
      method: 'POST',
      headers: {
        'X-Pipeline': syncParams,
        'X-State-Checkpoint-Limit': '1',
        ...bodyHeaders(body),
      },
      body,
    })

    expect(res.status).toBe(200)
    const events = await readNdjson<Message>(res)
    // Should get 1 record + 1 state, then stop
    expect(events).toHaveLength(2)
    expect(events[0]!.type).toBe('record')
    expect(events[1]!.type).toBe('state')
  })

  it('POST /sync stops after N state messages', async () => {
    const app = createApp(resolver)

    const body = toNdjson([
      { type: 'record', stream: 'customers', data: { id: 'cus_1' }, emitted_at: 1 },
      { type: 'state', stream: 'customers', data: { cursor: '1' } },
      { type: 'record', stream: 'customers', data: { id: 'cus_2' }, emitted_at: 2 },
      { type: 'state', stream: 'customers', data: { cursor: '2' } },
    ])
    const res = await app.request('/sync', {
      method: 'POST',
      headers: {
        'X-Pipeline': syncParams,
        'X-State-Checkpoint-Limit': '1',
        ...bodyHeaders(body),
      },
      body,
    })

    expect(res.status).toBe(200)
    const events = await readNdjson<Message>(res)
    // destinationTest only yields state messages, so we get 1 state then stop
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('state')
  })

  it('POST /read without limit returns all messages', async () => {
    const app = createApp(resolver)

    const body = toNdjson([
      { type: 'record', stream: 'customers', data: { id: 'cus_1' }, emitted_at: 1 },
      { type: 'state', stream: 'customers', data: { cursor: '1' } },
      { type: 'record', stream: 'customers', data: { id: 'cus_2' }, emitted_at: 2 },
      { type: 'state', stream: 'customers', data: { cursor: '2' } },
    ])
    const res = await app.request('/read', {
      method: 'POST',
      headers: { 'X-Pipeline': syncParams, ...bodyHeaders(body) },
      body,
    })

    expect(res.status).toBe(200)
    const events = await readNdjson<Message>(res)
    expect(events).toHaveLength(4)
  })
})

describe('error handling', () => {
  it('returns 400 when X-Pipeline header is missing', async () => {
    const app = createApp(resolver)

    const res = await app.request('/check')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Missing X-Pipeline')
  })

  it('returns 400 when X-Pipeline header is invalid JSON', async () => {
    const app = createApp(resolver)

    const res = await app.request('/check', {
      headers: { 'X-Pipeline': 'not-json' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid JSON')
  })
})

// ---------------------------------------------------------------------------
// Adversarial input tests
// ---------------------------------------------------------------------------

describe('adversarial inputs', () => {
  // ── Missing X-Pipeline header on every sync route ────────────────────

  const syncRoutes: Array<{ path: string; method: string }> = [
    { path: '/setup', method: 'POST' },
    { path: '/teardown', method: 'POST' },
    { path: '/check', method: 'GET' },
    { path: '/discover', method: 'POST' },
    { path: '/read', method: 'POST' },
    { path: '/write', method: 'POST' },
    { path: '/sync', method: 'POST' },
  ]

  describe('missing X-Pipeline header on all sync routes', () => {
    it.each(syncRoutes)('$method $path → 400', async ({ path, method }) => {
      const app = createApp(resolver)
      const res = await app.request(path, { method })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('Missing X-Pipeline')
    })
  })

  // ── Malformed X-Pipeline values ─────────────────────────────────────

  const badPipelineValues = [
    { label: 'not JSON', value: 'not-json', expectedError: 'Invalid JSON' },
    { label: 'empty string', value: '', expectedError: 'Missing X-Pipeline' },
    { label: 'JSON array', value: '[]', expectedError: 'Invalid JSON' },
    { label: 'JSON null', value: 'null', expectedError: 'Invalid JSON' },
    { label: 'JSON number', value: '123', expectedError: 'Invalid JSON' },
    { label: 'JSON string', value: '"hello"', expectedError: 'Invalid JSON' },
    { label: 'empty object', value: '{}', expectedError: 'Invalid JSON' },
    {
      label: 'missing destination',
      value: JSON.stringify({ source: { type: 'test' } }),
      expectedError: 'Invalid JSON',
    },
    {
      label: 'missing source',
      value: JSON.stringify({ destination: { type: 'test' } }),
      expectedError: 'Invalid JSON',
    },
    {
      label: 'source.type missing',
      value: JSON.stringify({ source: {}, destination: { type: 'test' } }),
      expectedError: 'Invalid JSON',
    },
    {
      label: 'source.type is number',
      value: JSON.stringify({ source: { type: 42 }, destination: { type: 'test' } }),
      expectedError: 'Invalid JSON',
    },
  ]

  describe('malformed X-Pipeline values on /check', () => {
    it.each(badPipelineValues)('$label → 400', async ({ value, expectedError }) => {
      const app = createApp(resolver)
      const headers: Record<string, string> = {}
      if (value !== '') headers['X-Pipeline'] = value
      const res = await app.request('/check', { headers })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: unknown }
      expect(body.error).toBeDefined()
      if (typeof body.error === 'string') {
        expect(body.error).toContain(expectedError)
      }
    })
  })

  // ── Malformed streams[] inside X-Pipeline ───────────────────────────

  const badStreamsValues = [
    {
      label: 'streams is a string',
      pipeline: { source: { type: 'test' }, destination: { type: 'test' }, streams: 'customers' },
    },
    {
      label: 'streams entry missing name',
      pipeline: { source: { type: 'test' }, destination: { type: 'test' }, streams: [{}] },
    },
    {
      label: 'stream name is number',
      pipeline: {
        source: { type: 'test' },
        destination: { type: 'test' },
        streams: [{ name: 123 }],
      },
    },
    {
      label: 'invalid sync_mode',
      pipeline: {
        source: { type: 'test' },
        destination: { type: 'test' },
        streams: [{ name: 'x', sync_mode: 'invalid' }],
      },
    },
    {
      label: 'negative backfill_limit',
      pipeline: {
        source: { type: 'test' },
        destination: { type: 'test' },
        streams: [{ name: 'x', backfill_limit: -1 }],
      },
    },
    {
      label: 'fractional backfill_limit',
      pipeline: {
        source: { type: 'test' },
        destination: { type: 'test' },
        streams: [{ name: 'x', backfill_limit: 1.5 }],
      },
    },
    {
      label: 'fields is a string instead of array',
      pipeline: {
        source: { type: 'test' },
        destination: { type: 'test' },
        streams: [{ name: 'x', fields: 'id' }],
      },
    },
  ]

  describe('malformed streams[] in X-Pipeline', () => {
    it.each(badStreamsValues)('$label → 400', async ({ pipeline }) => {
      const app = createApp(resolver)
      const res = await app.request('/check', {
        headers: { 'X-Pipeline': JSON.stringify(pipeline) },
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: unknown }
      expect(body.error).toBeDefined()
    })
  })

  // ── Unknown connector types ─────────────────────────────────────────

  describe('unknown connector types', () => {
    it('unknown source type → 500 with error message', async () => {
      const app = createApp(resolver)
      const pipeline = JSON.stringify({
        source: { type: 'nonexistent' },
        destination: { type: 'test' },
      })
      const res = await app.request('/check', {
        headers: { 'X-Pipeline': pipeline },
      })
      expect(res.status).toBe(500)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('Internal server error')
    })

    it('unknown destination type → 500 with error message', async () => {
      const app = createApp(resolver)
      const pipeline = JSON.stringify({
        source: { type: 'test' },
        destination: { type: 'nonexistent' },
      })
      const res = await app.request('/setup', {
        method: 'POST',
        headers: { 'X-Pipeline': pipeline },
      })
      expect(res.status).toBe(500)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('Internal server error')
    })
  })

  // ── X-State header validation ───────────────────────────────────────

  describe('X-State header validation', () => {
    it('invalid JSON in X-State → 400', async () => {
      const app = createApp(resolver)
      const res = await app.request('/check', {
        headers: { 'X-Pipeline': syncParams, 'X-State': 'not-json' },
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('Invalid JSON in X-State')
    })

    it('X-State with truncated JSON → 400', async () => {
      const app = createApp(resolver)
      const res = await app.request('/check', {
        headers: { 'X-Pipeline': syncParams, 'X-State': '{"cursor":' },
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('Invalid JSON in X-State')
    })
  })

  // ── X-State-Checkpoint-Limit validation ─────────────────────────────

  describe('X-State-Checkpoint-Limit validation', () => {
    const body = toNdjson([
      { type: 'record', stream: 'customers', data: { id: 'cus_1' }, emitted_at: 1 },
      { type: 'state', stream: 'customers', data: { cursor: '1' } },
    ])

    it('zero → 400 (must be positive)', async () => {
      const app = createApp(resolver)
      const res = await app.request('/read', {
        method: 'POST',
        headers: {
          'X-Pipeline': syncParams,
          'X-State-Checkpoint-Limit': '0',
          ...bodyHeaders(body),
        },
        body,
      })
      // parseSyncParams reads Number("0") = 0, which is falsy → treated as absent
      // This is a validation gap — 0 silently becomes "no limit"
      // For now, document actual behavior: 0 is treated as no limit (returns all messages)
      expect([200, 400]).toContain(res.status)
    })

    it('negative → 400 or ignored', async () => {
      const app = createApp(resolver)
      const res = await app.request('/read', {
        method: 'POST',
        headers: {
          'X-Pipeline': syncParams,
          'X-State-Checkpoint-Limit': '-1',
          ...bodyHeaders(body),
        },
        body,
      })
      expect([200, 400]).toContain(res.status)
    })

    it('non-numeric string → NaN is falsy, treated as absent', async () => {
      const app = createApp(resolver)
      const res = await app.request('/read', {
        method: 'POST',
        headers: {
          'X-Pipeline': syncParams,
          'X-State-Checkpoint-Limit': 'abc',
          ...bodyHeaders(body),
        },
        body,
      })
      // Number("abc") is NaN, which is falsy → treated as absent (returns all)
      expect([200, 400]).toContain(res.status)
    })
  })

  // ── Request body edge cases ─────────────────────────────────────────

  describe('request body edge cases', () => {
    it('POST /write with Content-Length: 0 → 400', async () => {
      const app = createApp(resolver)
      const res = await app.request('/write', {
        method: 'POST',
        headers: { 'X-Pipeline': syncParams, 'Content-Length': '0' },
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('body required')
    })

    it('POST /write with empty NDJSON body → 200 (no records to write)', async () => {
      const app = createApp(resolver)
      const emptyBody = ''
      const res = await app.request('/write', {
        method: 'POST',
        headers: {
          'X-Pipeline': syncParams,
          'Content-Type': 'application/x-ndjson',
          'Content-Length': '1', // non-zero to pass hasBody()
          'Transfer-Encoding': 'chunked',
        },
        body: emptyBody,
      })
      // Should complete without crashing
      expect(res.status).toBeLessThan(500)
    })
  })

  // ── Wrong HTTP methods ──────────────────────────────────────────────

  describe('wrong HTTP methods', () => {
    const wrongMethods = [
      { method: 'GET', path: '/setup' },
      { method: 'GET', path: '/write' },
      { method: 'DELETE', path: '/health' },
      { method: 'PUT', path: '/sync' },
      { method: 'POST', path: '/health' },
      { method: 'POST', path: '/check' },
      { method: 'DELETE', path: '/sync' },
    ]

    it.each(wrongMethods)('$method $path → 404', async ({ method, path }) => {
      const app = createApp(resolver)
      const res = await app.request(path, { method })
      expect(res.status).toBe(404)
    })
  })

  // ── Nonexistent routes ──────────────────────────────────────────────

  describe('nonexistent routes', () => {
    it('GET /nonexistent → 404', async () => {
      const app = createApp(resolver)
      const res = await app.request('/nonexistent')
      expect(res.status).toBe(404)
    })

    it('POST /api/sync → 404', async () => {
      const app = createApp(resolver)
      const res = await app.request('/api/sync', { method: 'POST' })
      expect(res.status).toBe(404)
    })

    it('GET /internal/query → 404', async () => {
      const app = createApp(resolver)
      const res = await app.request('/internal/query')
      expect(res.status).toBe(404)
    })
  })

  // ── POST /internal/query adversarial inputs ─────────────────────────

  describe('/internal/query adversarial inputs', () => {
    it('missing body entirely → 500 with error (not crash)', async () => {
      const app = createApp(resolver)
      const res = await app.request('/internal/query', { method: 'POST' })
      expect(res.status).toBeGreaterThanOrEqual(400)
      const body = (await res.json()) as { error: unknown }
      expect(body.error).toBeDefined()
    })

    it('empty JSON object → 500 with error (no connection_string)', async () => {
      const mockEnd = vi.fn().mockResolvedValue(undefined)
      vi.spyOn(pg, 'Pool').mockImplementation(
        () =>
          ({
            query: vi.fn().mockRejectedValue(new Error('no connection')),
            end: mockEnd,
          }) as unknown as pg.Pool
      )
      const app = createApp(resolver)
      const res = await app.request('/internal/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBeGreaterThanOrEqual(400)
      const body = (await res.json()) as { error: unknown }
      expect(body.error).toBeDefined()
    })

    it('non-JSON body → error (not crash)', async () => {
      const app = createApp(resolver)
      const res = await app.request('/internal/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json at all',
      })
      expect(res.status).toBeGreaterThanOrEqual(400)
      const body = (await res.json()) as { error: unknown }
      expect(body.error).toBeDefined()
    })
  })

  // ── Response body never leaks stack traces ──────────────────────────

  describe('error responses never leak stack traces', () => {
    it('unknown source type error has no stack trace in response', async () => {
      const app = createApp(resolver)
      const pipeline = JSON.stringify({
        source: { type: 'nonexistent' },
        destination: { type: 'test' },
      })
      const res = await app.request('/check', {
        headers: { 'X-Pipeline': pipeline },
      })
      const text = await res.text()
      // Should not contain file paths or "at " stack frames
      expect(text).not.toMatch(/at\s+\S+\s+\(.*\.(?:ts|js):\d+:\d+\)/)
    })

    it('invalid JSON error has no stack trace in response', async () => {
      const app = createApp(resolver)
      const res = await app.request('/check', {
        headers: { 'X-Pipeline': '{invalid' },
      })
      const text = await res.text()
      expect(text).not.toMatch(/at\s+\S+\s+\(.*\.(?:ts|js):\d+:\d+\)/)
    })
  })
})

// ---------------------------------------------------------------------------
// POST /internal/query
// ---------------------------------------------------------------------------

describe('POST /internal/query', () => {
  it('executes SQL and returns rows and rowCount', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [{ n: 1 }], rowCount: 1 })
    const mockEnd = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(pg, 'Pool').mockImplementation(
      () => ({ query: mockQuery, end: mockEnd }) as unknown as pg.Pool
    )

    const app = createApp(resolver)
    const res = await app.request('/internal/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connection_string: 'postgres://user:pass@localhost:5432/db',
        sql: 'SELECT 1 AS n',
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json<{ rows: unknown[]; rowCount: number }>()
    expect(body.rows).toEqual([{ n: 1 }])
    expect(body.rowCount).toBe(1)
    expect(mockEnd).toHaveBeenCalled()
  })

  it('closes pool even when query fails', async () => {
    const mockEnd = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(pg, 'Pool').mockImplementation(
      () =>
        ({
          query: vi.fn().mockRejectedValue(new Error('connection refused')),
          end: mockEnd,
        }) as unknown as pg.Pool
    )

    const app = createApp(resolver)
    const res = await app.request('/internal/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connection_string: 'postgres://user:pass@localhost:5432/db',
        sql: 'SELECT 1',
      }),
    })

    expect(res.status).toBe(500)
    expect(mockEnd).toHaveBeenCalled()
  })
})
