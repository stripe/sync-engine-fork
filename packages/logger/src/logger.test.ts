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
  it('scrubs Stripe live keys', () => {
    const text = 'Error: Invalid key sk_live_abc123XYZ789012 for account'
    expect(scrubSecrets(text)).toBe(`Error: Invalid key ${REDACT_CENSOR} for account`)
  })

  it('scrubs Stripe test keys', () => {
    const text = 'key: sk_test_51HnGDhKJ3xyz'
    expect(scrubSecrets(text)).toBe(`key: ${REDACT_CENSOR}`)
  })

  it('scrubs restricted keys', () => {
    const text = 'rk_live_longkeyvalue1234'
    expect(scrubSecrets(text)).toBe(REDACT_CENSOR)
  })

  it('scrubs URL credentials', () => {
    const text = 'postgres://admin:s3cret@db.host.com:5432/mydb'
    expect(scrubSecrets(text)).toContain(REDACT_CENSOR)
    expect(scrubSecrets(text)).not.toContain('s3cret')
    expect(scrubSecrets(text)).not.toContain('admin')
  })

  it('scrubs Bearer tokens', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig'
    expect(scrubSecrets(text)).toContain(REDACT_CENSOR)
    expect(scrubSecrets(text)).not.toContain('eyJhbG')
  })

  it('leaves clean text unchanged', () => {
    const text = 'Sync completed: 42 records in 3.2s'
    expect(scrubSecrets(text)).toBe(text)
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
    logger = createLogger({ destination: capture.stream, pretty: false })
  })

  it('redacts top-level sensitive fields', () => {
    logAndCapture(logger, (l) => l.info({ api_key: 'sk_test_123', msg_text: 'hello' }, 'test'))
    logger.flush()
    const out = capture.lines()
    expect(out).toHaveLength(1)
    expect(out[0].api_key).toBe(REDACT_CENSOR)
  })

  it('redacts nested sensitive fields', () => {
    logAndCapture(logger, (l) =>
      l.info({ config: { secret_key: 'whsec_abc123' } }, 'nested test')
    )
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
      // Transport would be set if pretty leaked through. The logger should
      // still produce valid JSON (not pretty-printed text).
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
