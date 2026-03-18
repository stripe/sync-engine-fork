import Stripe from 'stripe'
import type { ResourceConfig, StripeListResourceConfig } from './types'
import type { SigmaSyncProcessor } from './sigma/sigmaSyncProcessor'
import type { OpenApiSpec } from './openapi/types'
import {
  discoverListEndpoints,
  discoverNestedEndpoints,
  buildListFn,
  buildRetrieveFn,
  buildUnsupportedListFn,
  buildUnsupportedRetrieveFn,
  canResolveSdkResource,
} from './openapi/listFnResolver'

/**
 * Resources where the Stripe API does not support the `created` filter for pagination.
 * Everything else defaults to true.
 */
const NO_CREATED_FILTER: ReadonlySet<string> = new Set([
  'payment_method',
  'payment_methods',
  'tax_id',
  'tax_ids',
])

/**
 * The default set of table names synced when no explicit selection is made.
 * These correspond to the resources that were previously hardcoded with sync: true.
 */
export const DEFAULT_SYNC_OBJECTS: readonly string[] = [
  'products',
  'coupons',
  'prices',
  'plans',
  'customers',
  'subscriptions',
  'subscription_schedules',
  'invoices',
  'charges',
  'setup_intents',
  'payment_methods',
  'payment_intents',
  'tax_ids',
  'credit_notes',
  'disputes',
  'early_fraud_warnings',
  'refunds',
  'checkout_sessions',
]

export type StripeObject = string

export const CORE_SYNC_OBJECTS = DEFAULT_SYNC_OBJECTS as readonly string[]

export type CoreSyncObject = string

export const SYNC_OBJECTS = ['all', 'customer_with_entitlements', ...DEFAULT_SYNC_OBJECTS] as const

export type SyncObjectName = string

export const REVALIDATE_ENTITIES = [
  ...DEFAULT_SYNC_OBJECTS,
  'radar.early_fraud_warning',
  'subscription_schedule',
  'entitlements',
] as const
export type RevalidateEntityName = (typeof REVALIDATE_ENTITIES)[number]

export const RUNTIME_REQUIRED_TABLES: ReadonlyArray<string> = [
  ...DEFAULT_SYNC_OBJECTS,
  'subscription_items',
  'checkout_session_line_items',
  'features',
]

export const RESOURCE_TABLE_NAME_MAP: Record<string, string> = Object.fromEntries(
  DEFAULT_SYNC_OBJECTS.map((t) => [t, t])
)

/**
 * Build a ResourceConfig for every listable resource discovered in the OpenAPI spec.
 * All resources get list + retrieve functions derived dynamically from the spec paths.
 */
export function buildResourceRegistry(
  stripe: Stripe,
  spec: OpenApiSpec
): Record<string, ResourceConfig> {
  const endpoints = discoverListEndpoints(spec)
  const nestedEndpoints = discoverNestedEndpoints(spec, endpoints)
  const registry: Record<string, ResourceConfig> = {}
  let order = 0
  const seenNested = new Set<string>()

  for (const [tableName, endpoint] of endpoints) {
    if (!canResolveSdkResource(stripe, endpoint.apiPath)) continue

    const children = nestedEndpoints
      .filter((n) => n.parentTableName === tableName)
      .map((n) => ({
        tableName: n.tableName,
        resourceId: n.resourceId,
        apiPath: n.apiPath,
        parentParamName: n.parentParamName,
        supportsPagination: n.supportsPagination,
      }))

    order += 1
    const config: StripeListResourceConfig = {
      order,
      tableName,
      supportsCreatedFilter: !NO_CREATED_FILTER.has(tableName),
      sync: true,
      dependencies: [],
      listFn: buildListFn(stripe, endpoint.apiPath),
      retrieveFn: buildRetrieveFn(stripe, endpoint.apiPath),
      nestedResources: children.length > 0 ? children : undefined,
    }
    registry[tableName] = config
    registry[endpoint.resourceId] = config
  }

  for (const nested of nestedEndpoints) {
    if (!nested.parentTableName || registry[nested.tableName] || registry[nested.resourceId]) {
      continue
    }
    if (seenNested.has(nested.tableName)) {
      continue
    }
    seenNested.add(nested.tableName)

    order += 1
    const config: StripeListResourceConfig = {
      order,
      tableName: nested.tableName,
      supportsCreatedFilter: false,
      sync: false,
      dependencies: [],
      listFn: buildUnsupportedListFn(nested.apiPath),
      retrieveFn: buildUnsupportedRetrieveFn(nested.apiPath),
      nestedResources: undefined,
      parentParamName: nested.parentParamName,
    }

    registry[nested.tableName] = config
    registry[nested.resourceId] = config
  }

  return registry
}

export function buildSigmaRegistry(
  sigma: SigmaSyncProcessor,
  coreRegistry: Record<string, ResourceConfig>
): Record<string, ResourceConfig> {
  const maxOrder = Math.max(...Object.values(coreRegistry).map((cfg) => cfg.order))
  return sigma.buildSigmaRegistryEntries(maxOrder)
}

export const STRIPE_OBJECT_TO_SYNC_OBJECT_ALIASES: Record<string, string> = {
  'checkout.session': 'checkout_sessions',
  'radar.early_fraud_warning': 'early_fraud_warnings',
  'entitlements.active_entitlement': 'active_entitlements',
  'entitlements.feature': 'active_entitlements',
  subscription_schedule: 'subscription_schedules',
}

export function normalizeStripeObjectName(stripeObjectName: string): string {
  return STRIPE_OBJECT_TO_SYNC_OBJECT_ALIASES[stripeObjectName] ?? stripeObjectName
}

export const PREFIX_RESOURCE_MAP: Record<string, string> = {
  cus_: 'customers',
  gcus_: 'customers',
  in_: 'invoices',
  price_: 'prices',
  prod_: 'products',
  sub_: 'subscriptions',
  seti_: 'setup_intents',
  pm_: 'payment_methods',
  dp_: 'disputes',
  du_: 'disputes',
  ch_: 'charges',
  pi_: 'payment_intents',
  txi_: 'tax_ids',
  cn_: 'credit_notes',
  issfr_: 'early_fraud_warnings',
  prv_: 'reviews',
  re_: 'refunds',
  feat_: 'active_entitlements',
  cs_: 'checkout_sessions',
}

const SORTED_PREFIXES = Object.keys(PREFIX_RESOURCE_MAP).sort((a, b) => b.length - a.length)

export function getResourceFromPrefix(stripeId: string): string | undefined {
  const prefix = SORTED_PREFIXES.find((p) => stripeId.startsWith(p))
  return prefix ? PREFIX_RESOURCE_MAP[prefix] : undefined
}

export function getResourceConfigFromId(
  stripeId: string,
  registry: Record<string, ResourceConfig>
): ResourceConfig | undefined {
  const resourceName = getResourceFromPrefix(stripeId)
  return resourceName ? registry[resourceName] : undefined
}

export function getTableName(object: string, registry: Record<string, ResourceConfig>): string {
  const config = registry[object]
  if (!config) throw new Error(`No resource config found for object type: ${object}`)
  return config.tableName
}
