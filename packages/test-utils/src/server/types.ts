export type SeedCustomersForListServerOptions = {
  /**
   * stripe-mock base URL (no trailing slash). Used to POST /v1/customers for a template object.
   * @default http://localhost:12111
   */
  stripeMockUrl?: string
  /** Authorization bearer value for stripe-mock. @default sk_test_fake */
  stripeMockApiKey?: string
  /** Number of customer rows to insert. */
  count: number
  /**
   * Synthetic ids are `${idPrefix}_${index padded with zeros}`.
   * @default cus_test
   */
  idPrefix?: string
  /** Zero-pad width for the numeric suffix. @default 5 */
  idPadLength?: number
  /** Spread `created` across this unix range (seconds). */
  createdRange: { startUnix: number; endUnix: number }
  /** upsertObjects batch size. @default 1000 */
  batchSize?: number
}

export type StripeListServerOptions = {
  port?: number
  host?: string
  apiVersion?: string
  openApiSpecPath?: string
  postgresUrl?: string
  schema?: string
  /** Unix timestamp for the fake account's `created` field. Controls backfill range start. */
  accountCreated?: number
  fetchImpl?: typeof globalThis.fetch
  /** Optional auth guard for Stripe API routes. */
  auth?: StripeListServerAuthOptions
  /** Optional injected failures for specific Stripe API routes. */
  failures?: StripeListServerFailureRule[]
  /** When set, seed `customers` in the list-server DB after schema ensure (stripe-mock template + upserts). */
  seedCustomers?: SeedCustomersForListServerOptions
}

export type StripeListServerAuthOptions = {
  /** Expected bearer token value (without the `Bearer ` prefix). */
  expectedBearerToken: string
  /**
   * Route patterns to protect. Defaults to all Stripe API routes (`/v1/*`, `/v2/*`).
   * Supports exact paths (e.g. `/v1/account`) and prefix globs ending in `*`.
   */
  protectedPaths?: string[]
  /** Override the Stripe-style error message returned for auth failures. */
  errorMessage?: string
}

export type StripeListServerFailureRule = {
  /** Exact route path or prefix glob ending in `*` (e.g. `/v1/customers` or `/v1/*`). */
  path: string
  /** HTTP method to match. Defaults to `GET`. */
  method?: string
  /** Response status code to return when this rule triggers. */
  status: number
  /**
   * Allow this many matching requests through before starting to fail.
   * Example: `after: 1` fails the second matching request.
   */
  after?: number
  /**
   * Number of matching requests to fail after the `after` threshold is reached.
   * Defaults to unlimited.
   */
  times?: number
  /**
   * Stripe-style error payload. When omitted, a generic error body is generated.
   * Returned as `{ error: ... }`.
   */
  stripeError?: {
    type?: string
    message: string
    code?: string
  }
  /** Raw JSON body override. Takes precedence over `stripeError` when set. */
  body?: Record<string, unknown>
}

export type StripeListServer = {
  host: string
  port: number
  url: string
  postgresUrl: string
  postgresMode: 'docker' | 'external'
  close: () => Promise<void>
  /** Present when `seedCustomers` was passed; ordered synthetic ids used for assertions. */
  seededCustomerIds?: string[]
}

export type PageResult = { data: Record<string, unknown>[]; hasMore: boolean; lastId?: string }

export type V1PageQuery = {
  limit: number
  afterId?: string
  beforeId?: string
  createdGt?: number
  createdGte?: number
  createdLt?: number
  createdLte?: number
}

export type V2PageQuery = {
  limit: number
  afterId?: string
}
