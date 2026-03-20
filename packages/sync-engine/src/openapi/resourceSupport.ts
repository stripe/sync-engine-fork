import type {
  OpenApiReferenceObject,
  OpenApiSchemaObject,
  OpenApiSchemaOrReference,
  OpenApiSpec,
  OpenApiStripeOperation,
} from './types'

export type ResourceSupportProfile = {
  resourceId: string
  hasObjectSchema: boolean
  hasStripeOperations: boolean
  listOperationCount: number
  listPathCount: number
  canonicalListPath?: string
  webhookEventTypes: string[]
  hasListEndpoint: boolean
  hasWebhookEvent: boolean
  supportsBackfill: boolean
  supportsRealtime: boolean
  isDeployable: boolean
}

type MutableResourceSupportProfile = {
  resourceId: string
  hasObjectSchema: boolean
  hasStripeOperations: boolean
  listOperationCount: number
  listPaths: Set<string>
  webhookEventTypes: Set<string>
}

export function buildResourceSupportProfiles(spec: OpenApiSpec): Map<string, ResourceSupportProfile> {
  const profiles = new Map<string, MutableResourceSupportProfile>()

  for (const schemaOrRef of Object.values(spec.components?.schemas ?? {})) {
    const schema = resolveSchema(schemaOrRef, spec)
    if (!schema) {
      continue
    }

    const resourceId = schema['x-resourceId']
    if (typeof resourceId !== 'string' || resourceId.length === 0) {
      continue
    }

    const operations = Array.isArray(schema['x-stripeOperations']) ? schema['x-stripeOperations'] : []
    const listPaths = new Set<string>()
    let listOperationCount = 0

    for (const operation of operations) {
      if (!isListOperation(operation)) {
        continue
      }
      listOperationCount += 1
      if (typeof operation.path === 'string' && operation.path.length > 0) {
        listPaths.add(operation.path)
      }
    }

    profiles.set(resourceId, {
      resourceId,
      hasObjectSchema: true,
      hasStripeOperations: operations.length > 0,
      listOperationCount,
      listPaths,
      webhookEventTypes: new Set<string>(),
    })
  }

  for (const [schemaName, schemaOrRef] of Object.entries(spec.components?.schemas ?? {})) {
    const schema = resolveSchema(schemaOrRef, spec)
    const eventType = schema?.['x-stripeEvent']?.type
    if (!schema || typeof eventType !== 'string' || eventType.length === 0) {
      continue
    }

    for (const resourceId of collectEventTargetResourceIds(schema, spec)) {
      const profile = profiles.get(resourceId)
      if (!profile) {
        continue
      }
      profile.webhookEventTypes.add(eventType)
    }
  }

  return new Map(
    Array.from(profiles.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([resourceId, profile]) => {
        const canonicalListPath =
          profile.listPaths.size === 1 ? Array.from(profile.listPaths)[0] : undefined
        const hasListEndpoint =
          profile.hasObjectSchema &&
          profile.hasStripeOperations &&
          profile.listOperationCount > 0 &&
          profile.listPaths.size === 1 &&
          !!canonicalListPath &&
          isCanonicalListPath(canonicalListPath)
        const webhookEventTypes = Array.from(profile.webhookEventTypes).sort((a, b) =>
          a.localeCompare(b)
        )
        const hasWebhookEvent = webhookEventTypes.length > 0

        return [
          resourceId,
          {
            resourceId,
            hasObjectSchema: profile.hasObjectSchema,
            hasStripeOperations: profile.hasStripeOperations,
            listOperationCount: profile.listOperationCount,
            listPathCount: profile.listPaths.size,
            canonicalListPath,
            webhookEventTypes,
            hasListEndpoint,
            hasWebhookEvent,
            supportsBackfill: hasListEndpoint,
            supportsRealtime: hasWebhookEvent,
            isDeployable: hasListEndpoint && hasWebhookEvent,
          },
        ] satisfies [string, ResourceSupportProfile]
      })
  )
}

function collectEventTargetResourceIds(
  schema: OpenApiSchemaObject,
  spec: OpenApiSpec
): Set<string> {
  const resourceIds = new Set<string>()
  const objectProperty = schema.properties?.object

  if (objectProperty && isReference(objectProperty)) {
    const resourceId = resolveResourceIdFromReference(objectProperty, spec)
    if (resourceId) {
      resourceIds.add(resourceId)
    }
  }

  if (objectProperty && isSchemaObject(objectProperty) && Array.isArray(objectProperty.anyOf)) {
    for (const candidate of objectProperty.anyOf) {
      if (!isReference(candidate)) {
        continue
      }
      const resourceId = resolveResourceIdFromReference(candidate, spec)
      if (resourceId) {
        resourceIds.add(resourceId)
      }
    }
  }

  const relatedObjectTypeEnums = schema.properties?.related_object
  if (
    relatedObjectTypeEnums &&
    isSchemaObject(relatedObjectTypeEnums) &&
    relatedObjectTypeEnums.properties?.type &&
    isSchemaObject(relatedObjectTypeEnums.properties.type) &&
    Array.isArray(relatedObjectTypeEnums.properties.type.enum)
  ) {
    for (const value of relatedObjectTypeEnums.properties.type.enum) {
      if (typeof value === 'string' && value.length > 0) {
        resourceIds.add(value)
      }
    }
  }

  return resourceIds
}

function isCanonicalListPath(pathName: string): boolean {
  return pathName.startsWith('/v1/') || pathName.startsWith('/v2/')
}

function isListOperation(operation: OpenApiStripeOperation): boolean {
  return operation.method_type === 'list' || operation.method_name === 'list'
}

function resolveResourceIdFromReference(
  reference: OpenApiReferenceObject,
  spec: OpenApiSpec
): string | undefined {
  const schema = resolveSchema(reference, spec)
  const resourceId = schema?.['x-resourceId']
  return typeof resourceId === 'string' && resourceId.length > 0 ? resourceId : undefined
}

function resolveSchema(
  schemaOrRef: OpenApiSchemaOrReference | undefined,
  spec: OpenApiSpec,
  seenRefs = new Set<string>()
): OpenApiSchemaObject | undefined {
  if (!schemaOrRef) {
    return undefined
  }

  if (isReference(schemaOrRef)) {
    if (seenRefs.has(schemaOrRef.$ref)) {
      return undefined
    }
    seenRefs.add(schemaOrRef.$ref)

    const match = schemaOrRef.$ref.match(/^#\/components\/schemas\/(.+)$/)
    if (!match) {
      return undefined
    }

    const target = spec.components?.schemas?.[match[1]]
    return resolveSchema(target, spec, seenRefs)
  }

  return isSchemaObject(schemaOrRef) ? schemaOrRef : undefined
}

function isReference(candidate: OpenApiSchemaOrReference): candidate is OpenApiReferenceObject {
  return '$ref' in candidate && typeof candidate.$ref === 'string'
}

function isSchemaObject(candidate: OpenApiSchemaOrReference): candidate is OpenApiSchemaObject {
  return !('$ref' in candidate)
}
