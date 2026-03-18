import type Stripe from 'stripe'
import type { OpenApiSpec } from './types'
import { OPENAPI_RESOURCE_TABLE_ALIASES } from './runtimeMappings'

const SCHEMA_REF_PREFIX = '#/components/schemas/'

type ListFn = (
  params: Stripe.PaginationParams & { created?: Stripe.RangeQueryParam }
) => Promise<{ data: unknown[]; has_more: boolean }>

export type ListEndpoint = {
  tableName: string
  resourceId: string
  apiPath: string
}

export type NestedEndpoint = {
  tableName: string
  resourceId: string
  apiPath: string
  parentTableName: string
  parentParamName: string
  supportsPagination: boolean
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

function resolveTableName(resourceId: string, aliases: Record<string, string>): string {
  const alias = aliases[resourceId]
  if (alias) return alias
  const normalized = resourceId.toLowerCase().replace(/[.]/g, '_')
  return normalized.endsWith('s') ? normalized : `${normalized}s`
}

/**
 * Scan the spec for list endpoints (GET paths that return a Stripe list object)
 * and return one entry per table. Prefers top-level paths over nested ones.
 */
export function discoverListEndpoints(
  spec: OpenApiSpec,
  aliases: Record<string, string> = OPENAPI_RESOURCE_TABLE_ALIASES
): Map<string, ListEndpoint> {
  const endpoints = new Map<string, ListEndpoint>()
  const paths = spec.paths
  if (!paths) return endpoints

  for (const [apiPath, pathItem] of Object.entries(paths)) {
    if (apiPath.includes('{')) continue

    const getOp = pathItem.get
    if (!getOp?.responses) continue

    const responseSchema = getOp.responses['200']?.content?.['application/json']?.schema
    if (!responseSchema) continue

    const objectProp = responseSchema.properties?.object
    if (!objectProp || !('enum' in objectProp) || !objectProp.enum?.includes('list')) continue

    const dataProp = responseSchema.properties?.data
    if (!dataProp || !('type' in dataProp) || dataProp.type !== 'array') continue

    const itemsRef = dataProp.items
    if (!itemsRef || !('$ref' in itemsRef) || typeof itemsRef.$ref !== 'string') continue
    if (!itemsRef.$ref.startsWith(SCHEMA_REF_PREFIX)) continue

    const schemaName = itemsRef.$ref.slice(SCHEMA_REF_PREFIX.length)
    const schema = spec.components?.schemas?.[schemaName]
    if (!schema || '$ref' in schema) continue

    const resourceId = schema['x-resourceId']
    if (!resourceId || typeof resourceId !== 'string') continue

    const tableName = resolveTableName(resourceId, aliases)
    if (!endpoints.has(tableName)) {
      endpoints.set(tableName, { tableName, resourceId, apiPath })
    }
  }

  return endpoints
}

/**
 * Scan the spec for nested list endpoints (paths with `{param}` segments that
 * return a Stripe list object) and map each to its parent resource.
 */
export function discoverNestedEndpoints(
  spec: OpenApiSpec,
  topLevelEndpoints: Map<string, ListEndpoint>,
  aliases: Record<string, string> = OPENAPI_RESOURCE_TABLE_ALIASES
): NestedEndpoint[] {
  const nested: NestedEndpoint[] = []
  const paths = spec.paths
  if (!paths) return nested

  const topLevelByPath = new Map<string, ListEndpoint>()
  for (const endpoint of topLevelEndpoints.values()) {
    topLevelByPath.set(endpoint.apiPath, endpoint)
  }

  for (const [apiPath, pathItem] of Object.entries(paths)) {
    if (!apiPath.includes('{')) continue

    const getOp = pathItem.get
    if (!getOp?.responses) continue

    const responseSchema = getOp.responses['200']?.content?.['application/json']?.schema
    if (!responseSchema) continue

    const objectProp = responseSchema.properties?.object
    if (!objectProp || !('enum' in objectProp) || !objectProp.enum?.includes('list')) continue

    const dataProp = responseSchema.properties?.data
    if (!dataProp || !('type' in dataProp) || dataProp.type !== 'array') continue

    const itemsRef = dataProp.items
    if (!itemsRef || !('$ref' in itemsRef) || typeof itemsRef.$ref !== 'string') continue
    if (!itemsRef.$ref.startsWith(SCHEMA_REF_PREFIX)) continue

    const schemaName = itemsRef.$ref.slice(SCHEMA_REF_PREFIX.length)
    const schema = spec.components?.schemas?.[schemaName]
    if (!schema || '$ref' in schema) continue

    const resourceId = schema['x-resourceId']
    if (!resourceId || typeof resourceId !== 'string') continue

    const paramMatch = apiPath.match(/\{([^}]+)\}/)
    if (!paramMatch) continue
    const parentParamName = paramMatch[1]

    const parentPath = apiPath.slice(0, apiPath.indexOf('/{'))
    const parentEndpoint = topLevelByPath.get(parentPath)
    if (!parentEndpoint) continue

    const params = getOp.parameters ?? []
    const supportsPagination = params.some(
      (p: { name?: string }) => p.name === 'limit'
    )

    nested.push({
      tableName: resolveTableName(resourceId, aliases),
      resourceId,
      apiPath,
      parentTableName: parentEndpoint.tableName,
      parentParamName,
      supportsPagination,
    })
  }

  return nested
}

function pathToSdkSegments(apiPath: string): string[] {
  return apiPath
    .replace(/^\/v[12]\//, '')
    .split('/')
    .filter((s) => !s.startsWith('{'))
    .map(snakeToCamel)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveStripeResource(stripe: Stripe, segments: string[], apiPath: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resource: any = stripe
  for (const segment of segments) {
    resource = resource?.[segment]
    if (!resource) {
      throw new Error(
        `Stripe SDK has no property "${segment}" when resolving path "${apiPath}"`
      )
    }
  }
  return resource
}

/**
 * Check whether an API path can be resolved to a Stripe SDK resource
 * that has both `.list()` and `.retrieve()` methods.
 */
export function canResolveSdkResource(stripe: Stripe, apiPath: string): boolean {
  try {
    const segments = pathToSdkSegments(apiPath)
    const resource = resolveStripeResource(stripe, segments, apiPath)
    return typeof resource.list === 'function' && typeof resource.retrieve === 'function'
  } catch {
    return false
  }
}

/**
 * Build a callable list function by navigating the Stripe SDK object using
 * the API path segments converted from snake_case to camelCase.
 * Path parameters (e.g. `{customer}`) are stripped automatically.
 */
export function buildListFn(stripe: Stripe, apiPath: string): ListFn {
  const segments = pathToSdkSegments(apiPath)
  return (params) => {
    const resource = resolveStripeResource(stripe, segments, apiPath)
    if (typeof resource.list !== 'function') {
      throw new Error(`Stripe SDK resource at "${apiPath}" has no list() method`)
    }
    return resource.list(params)
  }
}

type RetrieveFn = (id: string) => Promise<Stripe.Response<unknown>>

/**
 * Build a callable retrieve function by navigating the Stripe SDK object using
 * the API path segments converted from snake_case to camelCase.
 * Path parameters (e.g. `{customer}`) are stripped automatically.
 */
export function buildRetrieveFn(stripe: Stripe, apiPath: string): RetrieveFn {
  const segments = pathToSdkSegments(apiPath)
  return (id: string) => {
    const resource = resolveStripeResource(stripe, segments, apiPath)
    if (typeof resource.retrieve !== 'function') {
      throw new Error(`Stripe SDK resource at "${apiPath}" has no retrieve() method`)
    }
    return resource.retrieve(id)
  }
}

/**
 * Build a list function for nested resources that must be fetched by parent ID.
 * This path is not directly callable without parent context.
 */
export function buildUnsupportedListFn(apiPath: string): ListFn {
  return () => {
    throw new Error(`Cannot list nested resource at "${apiPath}" without parent context`)
  }
}

/**
 * Build a retrieve function for nested resources that need additional path context.
 */
export function buildUnsupportedRetrieveFn(apiPath: string): RetrieveFn {
  return () => {
    throw new Error(`Cannot retrieve nested resource at "${apiPath}" without parent context`)
  }
}

/**
 * Build a list function that calls Stripe rawRequest directly for a fixed endpoint.
 * Useful when the Stripe SDK does not expose a matching namespace.
 */
export function buildRawRequestListFn(stripe: Stripe, apiPath: string): ListFn {
  return (params) =>
    stripe.rawRequest('GET', apiPath, params) as unknown as Promise<{
      data: unknown[]
      has_more: boolean
    }>
}

/**
 * Return a callable list function for a given table name by looking up its
 * API path from the OpenAPI spec and resolving it against the Stripe SDK.
 */
export function getListFn(
  stripe: Stripe,
  tableName: string,
  spec: OpenApiSpec,
  aliases: Record<string, string> = OPENAPI_RESOURCE_TABLE_ALIASES
): ListFn {
  const endpoints = discoverListEndpoints(spec, aliases)
  const endpoint = endpoints.get(tableName)
  if (!endpoint) {
    throw new Error(`No list endpoint found for table "${tableName}"`)
  }
  return buildListFn(stripe, endpoint.apiPath)
}
