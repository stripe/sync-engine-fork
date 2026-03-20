export type OpenApiStripeOperation = {
  method_name?: string
  method_on?: string
  method_type?: string
  operation?: string
  path?: string
}

export type OpenApiStripeEvent = {
  type?: string
  kind?: string
}

export type OpenApiSchemaObject = {
  type?: string
  format?: string
  nullable?: boolean
  properties?: Record<string, OpenApiSchemaOrReference>
  items?: OpenApiSchemaOrReference
  oneOf?: OpenApiSchemaOrReference[]
  anyOf?: OpenApiSchemaOrReference[]
  allOf?: OpenApiSchemaOrReference[]
  enum?: unknown[]
  additionalProperties?: boolean | OpenApiSchemaOrReference
  'x-resourceId'?: string
  'x-stripeOperations'?: OpenApiStripeOperation[]
  'x-stripeEvent'?: OpenApiStripeEvent
  'x-expandableFields'?: string[]
  'x-expansionResources'?: {
    oneOf?: OpenApiSchemaOrReference[]
  }
}

export type OpenApiReferenceObject = {
  $ref: string
}

export type OpenApiSchemaOrReference = OpenApiSchemaObject | OpenApiReferenceObject

export type OpenApiMediaTypeObject = {
  schema?: OpenApiSchemaOrReference
}

export type OpenApiResponseObject = {
  content?: Record<string, OpenApiMediaTypeObject>
}

export type OpenApiOperationObject = {
  responses?: Record<string, OpenApiResponseObject>
}

export type OpenApiPathItemObject = {
  get?: OpenApiOperationObject
  post?: OpenApiOperationObject
  put?: OpenApiOperationObject
  patch?: OpenApiOperationObject
  delete?: OpenApiOperationObject
  head?: OpenApiOperationObject
  options?: OpenApiOperationObject
  trace?: OpenApiOperationObject
  [method: string]: unknown
}

export type OpenApiSpec = {
  openapi: string
  info?: {
    version?: string
  }
  paths?: Record<string, OpenApiPathItemObject>
  components?: {
    schemas?: Record<string, OpenApiSchemaOrReference>
  }
}

export type ScalarType = 'text' | 'boolean' | 'bigint' | 'numeric' | 'json' | 'timestamptz'

export type ParsedColumn = {
  name: string
  type: ScalarType
  nullable: boolean
  expandableReference?: boolean
  referenceResourceIds?: string[]
}

export type ParsedResourceTable = {
  tableName: string
  resourceId: string
  resourceIds?: string[]
  sourceSchemaName: string
  sourceSchemaNames?: string[]
  sourcePaths?: string[]
  columns: ParsedColumn[]
}

export type ParsedOpenApiSpec = {
  apiVersion: string
  tables: ParsedResourceTable[]
}

export type ParseSpecOptions = {
  /**
   * Map Stripe x-resourceId values to concrete Postgres table names.
   * Entries are matched case-sensitively.
   */
  resourceAliases?: Record<string, string>
  /**
   * Restrict parsing to these table names.
   * If omitted, every x-resourceId entry eligible for the selected resourceScope is parsed.
   */
  allowedTables?: string[]
  /**
   * Controls which OpenAPI resource schemas are eligible for projection.
   * - 'collection_backed': only resources discoverable from collection GET list responses
   * - 'get_backed': GET-retrievable resources discovered from successful GET responses,
   *   plus SDK GET-operation metadata fallbacks, excluding deleted variants
   * - 'response_backed': all resources surfaced by successful API responses
   * - 'resource_id_backed': all schemas surfaced by x-resourceId metadata
   */
  resourceScope?: 'collection_backed' | 'get_backed' | 'response_backed' | 'resource_id_backed'
}

export type ResolveSpecConfig = {
  apiVersion: string
  openApiSpecPath?: string
  cacheDir?: string
}

export type ResolvedOpenApiSpec = {
  apiVersion: string
  spec: OpenApiSpec
  source: 'explicit_path' | 'cache' | 'github'
  cachePath?: string
  commitSha?: string
}

export type WritePlan = {
  tableName: string
  conflictTarget: string[]
  extraColumns: Array<{ column: string; pgType: string; entryKey: string }>
  metadataColumns: ['_raw_data', '_last_synced_at', '_account_id']
}
