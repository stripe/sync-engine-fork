import pino, { type Logger, type LoggerOptions } from 'pino'
import {
  REDACT_CENSOR,
  REDACT_PATHS,
  scrubSecrets,
  scrubValue,
  isPlainObject,
} from './redaction.js'

export type { Logger }

export type CreateLoggerOptions = {
  name?: string
  level?: string
  /**
   * Additional redaction paths beyond the defaults. Uses fast-redact syntax.
   * Note: default paths only cover depth 0 and 1. For deeper nesting, supply
   * explicit paths here (e.g. `['outer.inner.api_key']`).
   */
  redactPaths?: string[]
  /** Enable pretty-printing (reads LOG_PRETTY env var by default) */
  pretty?: boolean
  /** Pino destination — defaults to stdout (fd 1) */
  destination?: pino.DestinationStream | number
}

const REQUEST_HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'content-length',
  'content-type',
  'host',
  'traceparent',
  'tracestate',
  'user-agent',
  'x-request-id',
])

export const REQUEST_HEADER_REDACT = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
])

function parseBooleanEnv(value: string | undefined): boolean {
  if (value == null) return false
  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true
    default:
      return false
  }
}

function errSerializer(err: Error): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    type: err.constructor?.name ?? 'Error',
    message: scrubSecrets(err.message),
    ...(err.stack ? { stack: scrubSecrets(err.stack) } : {}),
  }
  for (const key of Object.keys(err)) {
    if (key === 'message' || key === 'stack' || key === 'type') continue
    obj[key] = scrubValue((err as unknown as Record<string, unknown>)[key])
  }
  return obj
}

function requestHeadersSerializer(headers: unknown): Record<string, unknown> {
  if (!isPlainObject(headers)) {
    return { value: scrubValue(headers) }
  }

  const out: Record<string, unknown> = {}
  let omittedHeaderCount = 0

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase()
    if (REQUEST_HEADER_REDACT.has(key)) {
      out[key] = REDACT_CENSOR
      continue
    }
    if (!REQUEST_HEADER_ALLOWLIST.has(key)) {
      omittedHeaderCount += 1
      continue
    }
    out[key] = scrubValue(rawValue)
  }

  if (omittedHeaderCount > 0) {
    out.omitted_header_count = omittedHeaderCount
  }

  return out
}

/**
 * Create a structured logger with PII redaction built in.
 * All sync-engine packages should use this instead of raw console calls.
 * If logs are exported to a collector, keep downstream redaction enabled as a final safety net.
 */
export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const level = opts.level ?? process.env.LOG_LEVEL ?? 'info'
  const pretty = opts.pretty ?? parseBooleanEnv(process.env.LOG_PRETTY)

  const redactPaths = [...REDACT_PATHS, ...(opts.redactPaths ?? [])]

  const options: LoggerOptions = {
    level,
    redact: {
      paths: redactPaths,
      censor: REDACT_CENSOR,
    },
    serializers: {
      err: errSerializer,
      request_headers: requestHeadersSerializer,
    },
    hooks: {
      // Final pass safety net for message strings and any secrets that escaped structured redaction.
      streamWrite: scrubSecrets,
    },
    ...(opts.name ? { name: opts.name } : {}),
  }

  if (pretty) {
    if (typeof opts.destination === 'number') {
      options.transport = {
        target: 'pino-pretty',
        options: { destination: opts.destination },
      }
      return pino(options)
    }
    // pino ignores transport when a destination stream is provided,
    // so pretty-printing only works with fd-based destinations.
    options.transport = { target: 'pino-pretty' }
    return pino(options)
  }

  if (opts.destination != null) {
    return pino(
      options,
      typeof opts.destination === 'number' ? pino.destination(opts.destination) : opts.destination
    )
  }

  return pino(options)
}

const STDERR_FD = 2

/**
 * Create a logger that writes structured JSON to stderr.
 * Designed for subprocess connectors where stdout is the NDJSON data stream.
 * Pretty-printing is always disabled to avoid corrupting the NDJSON stream on stdout.
 */
export function createConnectorLogger(name: string): Logger {
  return createLogger({ name, destination: STDERR_FD, pretty: false })
}
