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
 * Redaction paths covering top-level and one-level-nested occurrences
 * of every sensitive key, plus paths for synced record payloads.
 *
 * fast-redact's `*` means "any key at this level", not a recursive glob,
 * so we need both `key` (top-level) and `*.key` (nested one level).
 */
export const REDACT_PATHS: string[] = [
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((k) => `*.${k}`),

  // Synced record payloads — never log business data flowing through the pipeline
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

/**
 * Regex patterns that match secrets embedded in free-text strings
 * (error messages, stack traces, URLs). Used by the custom error serializer.
 */
export const SECRET_PATTERNS: RegExp[] = [
  // Stripe API keys and restricted keys
  /\b[sr]k_(live|test)_[A-Za-z0-9]{10,}\b/g,
  // URLs with embedded credentials  (e.g. postgres://user:pass@host)
  /:\/\/[^/\s]+:[^/\s]+@/g,
  // Bearer tokens in error text
  /Bearer\s+[A-Za-z0-9._\-]{20,}/gi,
]

export function scrubSecrets(text: string): string {
  let result = text
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    result = result.replace(pattern, REDACT_CENSOR)
  }
  return result
}
