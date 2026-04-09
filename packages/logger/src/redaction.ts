const SENSITIVE_KEYS = [
  'api_key',
  'apiKey',
  'secret',
  'secret_key',
  'secretKey',
  'token',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'password',
  'authorization',
  'webhook_secret',
  'webhookSecret',
  'connection_string',
  'connectionString',
  'database_url',
  'databaseUrl',
  'credentials',
  'cookie',
  'cookies',
  'private_key',
  'privateKey',
  'stripe_key',
  'stripeKey',
  'supabase_key',
  'supabaseKey',
  'service_role_key',
  'serviceRoleKey',
  'dsn',
]

/**
 * `fast-redact` paths for depth 0 and 1 only (`key`, `*.key`).
 * Depth 2+ secrets are caught by `SECRET_PATTERNS` via `streamWrite`
 * or registered serializers. For deeper paths, pass custom `redactPaths`.
 */
export const REDACT_PATHS: string[] = [
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((k) => `*.${k}`),

  // Synced record payloads
  'record.data',
  '*.record.data',
  'request_body',
  '*.request_body',
  'requestBody',
  '*.requestBody',
  'response_body',
  '*.response_body',
  'responseBody',
  '*.responseBody',
]

export const REDACT_CENSOR = '[REDACTED]'

/** Regexes for secrets in free text. Anchor with `\b`; must use the `g` flag. */
export const SECRET_PATTERNS: RegExp[] = [
  /\b[sr]k_(live|test)_[A-Za-z0-9]{10,}\b/g, // Stripe API / restricted keys
  /\bwhsec_[A-Za-z0-9]{10,}\b/g, // Stripe webhook secrets
  /Bearer\s+[A-Za-z0-9._\-]{20,}/gi, // Bearer tokens
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, // JWTs
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key IDs
  /\bgh[pso]_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
]

// URL credentials — preserves URL structure
const URL_CREDS_PATTERN = /:\/\/([^/\s]+):([^/\s]+)@/g

export function scrubSecrets(text: string): string {
  let result = text
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    result = result.replace(pattern, REDACT_CENSOR)
  }
  URL_CREDS_PATTERN.lastIndex = 0
  result = result.replace(URL_CREDS_PATTERN, `://${REDACT_CENSOR}@`)
  return result
}

// Deep value scrubbing (safety net for logger serializers)

function isNonNullObject(value: unknown): value is object {
  return value != null && typeof value === 'object'
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isNonNullObject(value) || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const MAX_SCRUB_DEPTH = 6
const MAX_SCRUB_NODES = 500

function summarizeBinary(type: string, byteLength: number): Record<string, unknown> {
  return { type, byte_length: byteLength, data_redacted: true }
}

/** Recursively scrub secrets from an arbitrary value. */
export function scrubValue(
  value: unknown,
  state: { nodes: number; seen: WeakSet<object> } = { nodes: 0, seen: new WeakSet() },
  depth = 0
): unknown {
  if (typeof value === 'string') return scrubSecrets(value)
  if (value == null || typeof value !== 'object') return value

  if (Buffer.isBuffer(value)) return summarizeBinary('Buffer', value.byteLength)
  if (value instanceof ArrayBuffer) return summarizeBinary('ArrayBuffer', value.byteLength)
  if (ArrayBuffer.isView(value)) return summarizeBinary(value.constructor.name, value.byteLength)
  if (value instanceof Date) return value.toISOString()
  if (value instanceof URL || value instanceof URLSearchParams) {
    return scrubSecrets(value.toString())
  }
  if (value instanceof Map) return { type: 'Map', size: value.size, data_redacted: true }
  if (value instanceof Set) return { type: 'Set', size: value.size, data_redacted: true }

  if (state.seen.has(value)) return '[Circular]'
  if (depth >= MAX_SCRUB_DEPTH) return '[Truncated: depth limit]'
  state.nodes += 1
  if (state.nodes > MAX_SCRUB_NODES) return '[Truncated: node limit]'
  state.seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, state, depth + 1))
  }

  if (!isPlainObject(value)) {
    const json = (value as { toJSON?: () => unknown }).toJSON
    if (typeof json === 'function') {
      try {
        return scrubValue(json.call(value), state, depth + 1)
      } catch {
        return `[${value.constructor?.name ?? 'Object'}]`
      }
    }
    return `[${value.constructor?.name ?? 'Object'}]`
  }

  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    out[key] = scrubValue(entry, state, depth + 1)
  }
  return out
}
