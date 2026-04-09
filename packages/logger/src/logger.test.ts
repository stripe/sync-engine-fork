import { Writable } from 'node:stream'
import { describe, it, expect, beforeEach } from 'vitest'
import { createLogger, createConnectorLogger, type Logger } from './logger.js'
import { REDACT_CENSOR, scrubSecrets, REDACT_PATHS } from './redaction.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCapture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, cb) {
      chunks.push(chunk.toString())
      cb()
    },
  })
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  }
}

function logAndCapture(logger: Logger, fn: (l: Logger) => void) {
  fn(logger)
}

// ---------------------------------------------------------------------------
// scrubSecrets
// ---------------------------------------------------------------------------

describe('scrubSecrets', () => {
  it('preserves URL structure when scrubbing credentials', () => {
    expect(scrubSecrets('postgres://admin:s3cret@db.host.com:5432/mydb')).toBe(
      `postgres://${REDACT_CENSOR}@db.host.com:5432/mydb`
    )
  })

  it('leaves clean text unchanged', () => {
    expect(scrubSecrets('Sync completed: 42 records in 3.2s')).toBe(
      'Sync completed: 42 records in 3.2s'
    )
  })

  it.each([
    ['Stripe live key', 'sk_live_abc123XYZ789012'],
    ['Stripe test key', 'sk_test_51HnGDhKJ3xyz'],
    ['Stripe restricted key', 'rk_live_longkeyvalue1234'],
    ['webhook signing secret', 'whsec_abc123XYZ789012'],
    ['Bearer token', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig'],
    ['URL credentials', 'postgres://admin:s3cret@db.host.com:5432/mydb'],
    [
      'Supabase JWT key',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJhbm9uIn0.abcdefghijklmnopqrstuvwx',
    ],
    ['AWS access key', 'AKIAIOSFODNN7EXAMPLE'],
    ['GitHub PAT', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'],
    ['GitHub OAuth token', 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'],
    ['GitHub fine-grained PAT', 'github_pat_11AABBC_xyzXYZxyzXYZxy'],
  ])('scrubs %s', (_label, secret) => {
    const text = `error: ${secret} leaked`
    const scrubbed = scrubSecrets(text)
    expect(scrubbed).not.toContain(secret)
    expect(scrubbed).toContain(REDACT_CENSOR)
  })
})

// ---------------------------------------------------------------------------
// REDACT_PATHS coverage
// ---------------------------------------------------------------------------

describe('REDACT_PATHS', () => {
  it('includes top-level and nested paths for every sensitive key', () => {
    expect(REDACT_PATHS).toContain('api_key')
    expect(REDACT_PATHS).toContain('*.api_key')
    expect(REDACT_PATHS).toContain('connection_string')
    expect(REDACT_PATHS).toContain('*.connection_string')
  })

  it('includes newly added keys', () => {
    for (const key of ['credentials', 'cookie', 'private_key', 'stripe_key', 'dsn']) {
      expect(REDACT_PATHS).toContain(key)
      expect(REDACT_PATHS).toContain(`*.${key}`)
    }
  })

  it('does not include bare *.data (overly broad)', () => {
    expect(REDACT_PATHS).not.toContain('*.data')
    expect(REDACT_PATHS).not.toContain('data')
  })

  it('includes record.data for synced payloads', () => {
    expect(REDACT_PATHS).toContain('record.data')
    expect(REDACT_PATHS).toContain('*.record.data')
  })
})

// ---------------------------------------------------------------------------
// createLogger — redaction
// ---------------------------------------------------------------------------

describe('createLogger redaction', () => {
  let capture: ReturnType<typeof createCapture>
  let logger: Logger

  beforeEach(() => {
    capture = createCapture()
    logger = createLogger({ destination: capture.stream, pretty: false, level: 'debug' })
  })

  it('redacts top-level sensitive fields', () => {
    logAndCapture(logger, (l) => l.info({ api_key: 'sk_test_123', msg_text: 'hello' }, 'test'))
    logger.flush()
    const out = capture.lines()
    expect(out).toHaveLength(1)
    expect(out[0].api_key).toBe(REDACT_CENSOR)
  })

  it('redacts nested sensitive fields', () => {
    logAndCapture(logger, (l) => l.info({ config: { secret_key: 'whsec_abc123' } }, 'nested test'))
    logger.flush()
    const out = capture.lines()
    expect(out).toHaveLength(1)
    const config = out[0].config as Record<string, unknown>
    expect(config.secret_key).toBe(REDACT_CENSOR)
  })

  it('redacts record.data payloads', () => {
    logAndCapture(logger, (l) =>
      l.info({ record: { data: { name: 'Alice', email: 'a@b.com' } } }, 'record')
    )
    logger.flush()
    const out = capture.lines()
    const record = out[0].record as Record<string, unknown>
    expect(record.data).toBe(REDACT_CENSOR)
  })

  it('does not redact non-sensitive fields named "data" at top level', () => {
    logAndCapture(logger, (l) =>
      l.info({ context: { data: { count: 5 } } }, 'should not be redacted')
    )
    logger.flush()
    const out = capture.lines()
    const context = out[0].context as Record<string, unknown>
    expect(context.data).toEqual({ count: 5 })
  })

  it('merges custom redactPaths with defaults', () => {
    const custom = createCapture()
    const customLogger = createLogger({
      destination: custom.stream,
      pretty: false,
      redactPaths: ['*.custom_secret'],
    })
    customLogger.info({ config: { custom_secret: 'hidden' } }, 'custom')
    customLogger.flush()
    const out = custom.lines()
    const config = out[0].config as Record<string, unknown>
    expect(config.custom_secret).toBe(REDACT_CENSOR)
  })
})

// ---------------------------------------------------------------------------
// createLogger — string value scrubbing (final safety hook)
// ---------------------------------------------------------------------------

describe('createLogger string value scrubbing', () => {
  let capture: ReturnType<typeof createCapture>
  let logger: Logger

  beforeEach(() => {
    capture = createCapture()
    logger = createLogger({ destination: capture.stream, pretty: false })
  })

  it('scrubs secrets from arbitrary string fields', () => {
    logAndCapture(logger, (l) =>
      l.error({ error: 'connection to postgres://admin:pass123@host:5432/db failed' }, 'db error')
    )
    logger.flush()
    const out = capture.lines()
    expect(out[0].error as string).not.toContain('pass123')
    expect(out[0].error as string).not.toContain('admin')
  })

  it('scrubs Stripe keys from any string field', () => {
    logAndCapture(logger, (l) =>
      l.warn({ detail: 'Invalid key sk_test_51HnGDhKJ3xyzABC' }, 'auth failure')
    )
    logger.flush()
    const out = capture.lines()
    expect(out[0].detail as string).not.toContain('sk_test_')
    expect(out[0].detail as string).toContain(REDACT_CENSOR)
  })

  it('scrubs secrets from message strings', () => {
    logAndCapture(logger, (l) =>
      l.error('connection to postgres://admin:pass123@host:5432/db failed')
    )
    logger.flush()
    const out = capture.lines()
    expect(out[0].msg as string).not.toContain('pass123')
    expect(out[0].msg as string).not.toContain('admin')
    expect(out[0].msg as string).toContain(REDACT_CENSOR)
  })

  it('scrubs secrets from nested string fields', () => {
    logAndCapture(logger, (l) =>
      l.error(
        {
          request: {
            url: 'postgres://admin:pass123@host:5432/db',
            headers: ['Bearer abcdefghijklmnopqrstuvwxyz123456'],
          },
        },
        'nested secret'
      )
    )
    logger.flush()
    const out = capture.lines()
    const request = out[0].request as Record<string, unknown>
    expect(request.url).toBe(`postgres://${REDACT_CENSOR}@host:5432/db`)
    expect(request.headers).toEqual([REDACT_CENSOR])
  })

  it('does not modify non-string fields', () => {
    logAndCapture(logger, (l) => l.info({ count: 42, active: true }, 'stats'))
    logger.flush()
    const out = capture.lines()
    expect(out[0].count).toBe(42)
    expect(out[0].active).toBe(true)
  })

  it('leaves clean strings unchanged', () => {
    logAndCapture(logger, (l) => l.info({ status: 'ok', region: 'us-east-1' }, 'healthy'))
    logger.flush()
    const out = capture.lines()
    expect(out[0].status).toBe('ok')
    expect(out[0].region).toBe('us-east-1')
  })
})

// ---------------------------------------------------------------------------
// createLogger — structured serializers
// ---------------------------------------------------------------------------

describe('createLogger structured serializers', () => {
  let capture: ReturnType<typeof createCapture>
  let logger: Logger

  beforeEach(() => {
    capture = createCapture()
    logger = createLogger({ destination: capture.stream, pretty: false, level: 'debug' })
  })

  it('allowlists and redacts request headers', () => {
    logAndCapture(logger, (l) =>
      l.debug(
        {
          request_headers: {
            authorization: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
            cookie: 'session=top-secret',
            'content-type': 'application/json',
            referer: 'https://example.com/?token=hidden',
            'x-custom': 'left-out',
          },
        },
        'request headers'
      )
    )
    logger.flush()
    const out = capture.lines()
    expect(out[0].request_headers).toEqual({
      authorization: REDACT_CENSOR,
      cookie: REDACT_CENSOR,
      'content-type': 'application/json',
      omitted_header_count: 2,
    })
  })
})

// ---------------------------------------------------------------------------
// createLogger — error serializer
// ---------------------------------------------------------------------------

describe('createLogger error serializer', () => {
  let capture: ReturnType<typeof createCapture>
  let logger: Logger

  beforeEach(() => {
    capture = createCapture()
    logger = createLogger({ destination: capture.stream, pretty: false })
  })

  it('scrubs Stripe keys from error messages', () => {
    const err = new Error('Invalid API key sk_test_51HnGDhKJ3xyzABC provided')
    logAndCapture(logger, (l) => l.error({ err }, 'request failed'))
    logger.flush()
    const out = capture.lines()
    const serialized = out[0].err as Record<string, unknown>
    expect(serialized.message).not.toContain('sk_test_')
    expect(serialized.message).toContain(REDACT_CENSOR)
  })

  it('scrubs connection strings from error messages', () => {
    const err = new Error('connection to postgres://admin:pass123@host:5432/db failed')
    logAndCapture(logger, (l) => l.error({ err }, 'db error'))
    logger.flush()
    const out = capture.lines()
    const serialized = out[0].err as Record<string, unknown>
    expect(serialized.message as string).not.toContain('pass123')
    expect(serialized.message as string).not.toContain('admin')
  })

  it('scrubs enumerable string properties on the error', () => {
    const err = Object.assign(new Error('fail'), {
      detail: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
      meta: { url: 'postgres://admin:pass123@host:5432/db' },
    })
    logAndCapture(logger, (l) => l.error({ err }, 'request failed'))
    logger.flush()
    const out = capture.lines()
    const serialized = out[0].err as Record<string, unknown>
    expect(serialized.detail).toBe(REDACT_CENSOR)
    expect(serialized.meta).toEqual({ url: `postgres://${REDACT_CENSOR}@host:5432/db` })
  })

  it('bounds deep recursive scrubbing on error properties', () => {
    let nested: Record<string, unknown> = { secret: 'sk_test_51HnGDhKJ3xyzABC' }
    for (const k of ['f', 'e', 'd', 'c', 'b', 'a']) nested = { [k]: nested }
    const err = Object.assign(new Error('fail'), { nested })
    logAndCapture(logger, (l) => l.error({ err }, 'depth bound'))
    logger.flush()
    const serialized = capture.lines()[0].err as Record<string, unknown>
    expect(serialized.nested).toEqual({
      a: { b: { c: { d: { e: { f: '[Truncated: depth limit]' } } } } },
    })
  })

  it('summarizes binary error properties instead of logging their contents', () => {
    const err = Object.assign(new Error('fail'), {
      payload: Buffer.from('secret'),
    })
    logAndCapture(logger, (l) => l.error({ err }, 'binary payload'))
    logger.flush()
    const out = capture.lines()
    const serialized = out[0].err as Record<string, unknown>
    expect(serialized.payload).toEqual({
      type: 'Buffer',
      byte_length: 6,
      data_redacted: true,
    })
  })

  it('preserves extra enumerable properties on the error', () => {
    const err = Object.assign(new Error('fail'), { code: 'ECONNREFUSED', port: 5432 })
    logAndCapture(logger, (l) => l.error({ err }, 'connection error'))
    logger.flush()
    const out = capture.lines()
    const serialized = out[0].err as Record<string, unknown>
    expect(serialized.code).toBe('ECONNREFUSED')
    expect(serialized.port).toBe(5432)
    expect(serialized.type).toBe('Error')
  })
})

describe('createLogger pretty env parsing', () => {
  it.each(['0', 'false'])('treats LOG_PRETTY=%s as disabled', (value) => {
    const origEnv = process.env.LOG_PRETTY
    const capture = createCapture()
    try {
      process.env.LOG_PRETTY = value
      const logger = createLogger({ destination: capture.stream })
      logger.info({ ok: true }, 'hello')
      logger.flush()
      expect(capture.lines()).toHaveLength(1)
    } finally {
      if (origEnv === undefined) {
        delete process.env.LOG_PRETTY
      } else {
        process.env.LOG_PRETTY = origEnv
      }
    }
  })
})

// ---------------------------------------------------------------------------
// createConnectorLogger
// ---------------------------------------------------------------------------

describe('createConnectorLogger', () => {
  it('creates a named logger', () => {
    const logger = createConnectorLogger('test-connector')
    expect(logger).toBeDefined()
  })

  it('is not affected by LOG_PRETTY env var', () => {
    const origEnv = process.env.LOG_PRETTY
    try {
      process.env.LOG_PRETTY = '1'
      const logger = createConnectorLogger('test-connector')
      expect(logger).toBeDefined()
    } finally {
      if (origEnv === undefined) {
        delete process.env.LOG_PRETTY
      } else {
        process.env.LOG_PRETTY = origEnv
      }
    }
  })
})

// ---------------------------------------------------------------------------
// createLogger — named logger output
// ---------------------------------------------------------------------------

describe('createLogger named logger output', () => {
  it('outputs valid NDJSON with the configured name', () => {
    const capture = createCapture()
    const logger = createLogger({
      name: 'test-connector',
      destination: capture.stream,
      pretty: false,
    })
    logger.info({ stream: 'customers' }, 'sync started')
    logger.flush()
    const out = capture.lines()
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('test-connector')
    expect(out[0].stream).toBe('customers')
    expect(out[0].msg).toBe('sync started')
    expect(out[0].level).toBe(30)
  })

  it('redacts secrets in named logger output', () => {
    const capture = createCapture()
    const logger = createLogger({
      name: 'test-connector',
      destination: capture.stream,
      pretty: false,
    })
    logger.error({ api_key: 'sk_test_secret123' }, 'auth failed')
    logger.flush()
    const out = capture.lines()
    expect(out[0].api_key).toBe(REDACT_CENSOR)
    expect(JSON.stringify(out[0])).not.toContain('sk_test_secret123')
  })
})
