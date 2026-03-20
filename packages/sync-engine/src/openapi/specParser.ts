import type {
  OpenApiOperationObject,
  OpenApiSchemaObject,
  OpenApiSchemaOrReference,
  OpenApiSpec,
  ParseSpecOptions,
  ParsedColumn,
  ParsedOpenApiSpec,
  ScalarType,
} from './types'
import { RUNTIME_REQUIRED_TABLES as DEFAULT_RUNTIME_REQUIRED_TABLES } from '../resourceRegistry'
import {
  OPENAPI_COMPATIBILITY_COLUMNS,
  OPENAPI_RESOURCE_TABLE_ALIASES as DEFAULT_OPENAPI_RESOURCE_TABLE_ALIASES,
} from './runtimeMappings'

const RESERVED_COLUMNS = new Set([
  'id',
  '_raw_data',
  '_last_synced_at',
  '_updated_at',
  '_account_id',
])

export const RUNTIME_REQUIRED_TABLES = DEFAULT_RUNTIME_REQUIRED_TABLES

export const OPENAPI_RESOURCE_TABLE_ALIASES = DEFAULT_OPENAPI_RESOURCE_TABLE_ALIASES
/** Backward-compatible alias for runtime resource table mappings. */
export const RUNTIME_RESOURCE_ALIASES = OPENAPI_RESOURCE_TABLE_ALIASES

type ColumnAccumulator = {
  type: ScalarType
  nullable: boolean
  expandableReference: boolean
  referenceResourceIds: Set<string>
}

type BackedResourceAccumulator = {
  sourcePaths: Set<string>
}

export class SpecParser {
  parse(spec: OpenApiSpec, options: ParseSpecOptions = {}): ParsedOpenApiSpec {
    const schemas = spec.components?.schemas
    if (!schemas || typeof schemas !== 'object') {
      throw new Error('OpenAPI spec is missing components.schemas')
    }

    const aliases = { ...OPENAPI_RESOURCE_TABLE_ALIASES, ...(options.resourceAliases ?? {}) }
    const allowedTables = options.allowedTables ? new Set(options.allowedTables) : null
    const resourceScope = options.resourceScope ?? 'collection_backed'
    const backedResourceIds = this.collectBackedResourceIds(spec, resourceScope)
    const tableMap = new Map<
      string,
      {
        resourceId: string
        resourceIds: Set<string>
        sourceSchemaName: string
        sourceSchemaNames: Set<string>
        sourcePaths: Set<string>
        columns: Map<string, ColumnAccumulator>
      }
    >()

    for (const schemaName of Object.keys(schemas).sort((a, b) => a.localeCompare(b))) {
      const schema = this.resolveSchema({ $ref: `#/components/schemas/${schemaName}` }, spec)
      const resourceId = schema['x-resourceId']
      if (!resourceId || typeof resourceId !== 'string') {
        continue
      }
      const backedResource = backedResourceIds.get(resourceId)
      if (!backedResource) {
        continue
      }

      const tableName = this.resolveTableName(resourceId, aliases)
      if (allowedTables && !allowedTables.has(tableName)) {
        continue
      }

      const propCandidates = this.collectPropertyCandidates(
        { $ref: `#/components/schemas/${schemaName}` },
        spec
      )
      const parsedColumns = this.parseColumns(propCandidates, spec)

      const existing = tableMap.get(tableName) ?? {
        resourceId,
        resourceIds: new Set<string>([resourceId]),
        sourceSchemaName: schemaName,
        sourceSchemaNames: new Set<string>([schemaName]),
        sourcePaths: new Set(backedResource.sourcePaths),
        columns: new Map<string, ColumnAccumulator>(),
      }

      existing.resourceIds.add(resourceId)
      existing.sourceSchemaNames.add(schemaName)
      if (schemaName.startsWith('v2.') && !existing.sourceSchemaName.startsWith('v2.')) {
        existing.sourceSchemaName = schemaName
      }
      for (const sourcePath of backedResource.sourcePaths) {
        existing.sourcePaths.add(sourcePath)
      }

      for (const column of parsedColumns) {
        const current = existing.columns.get(column.name)
        if (!current) {
          existing.columns.set(column.name, {
            type: column.type,
            nullable: column.nullable,
            expandableReference: column.expandableReference ?? false,
            referenceResourceIds: new Set(column.referenceResourceIds ?? []),
          })
          continue
        }
        existing.columns.set(column.name, {
          type: this.mergeTypes(current.type, column.type),
          nullable: current.nullable || column.nullable,
          expandableReference: current.expandableReference || (column.expandableReference ?? false),
          referenceResourceIds: new Set([
            ...current.referenceResourceIds,
            ...(column.referenceResourceIds ?? []),
          ]),
        })
      }

      tableMap.set(tableName, existing)
    }

    const compatibilityTableNames = allowedTables
      ? Array.from(allowedTables).filter(
          (tableName) =>
            tableMap.has(tableName) ||
            Object.prototype.hasOwnProperty.call(OPENAPI_COMPATIBILITY_COLUMNS, tableName)
        )
      : Array.from(tableMap.keys())

    for (const tableName of compatibilityTableNames.sort((a, b) => a.localeCompare(b))) {
      const current = tableMap.get(tableName) ?? {
        resourceId: tableName,
        resourceIds: new Set<string>(),
        sourceSchemaName: 'compatibility_fallback',
        sourceSchemaNames: new Set<string>(),
        sourcePaths: new Set<string>(),
        columns: new Map<string, ColumnAccumulator>(),
      }
      for (const compatibilityColumn of OPENAPI_COMPATIBILITY_COLUMNS[tableName] ?? []) {
        const existing = current.columns.get(compatibilityColumn.name)
        if (!existing) {
          current.columns.set(compatibilityColumn.name, {
            type: compatibilityColumn.type,
            nullable: compatibilityColumn.nullable,
            expandableReference: compatibilityColumn.expandableReference ?? false,
            referenceResourceIds: new Set<string>(),
          })
        }
      }
      tableMap.set(tableName, current)
    }

    const tables = Array.from(tableMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tableName, table]) => ({
        tableName,
        resourceId: table.resourceId,
        ...(table.resourceIds.size > 0
          ? {
              resourceIds: Array.from(table.resourceIds).sort((a, b) => a.localeCompare(b)),
            }
          : {}),
        sourceSchemaName: table.sourceSchemaName,
        ...(table.sourceSchemaNames.size > 0
          ? {
              sourceSchemaNames: Array.from(table.sourceSchemaNames).sort((a, b) =>
                a.localeCompare(b)
              ),
            }
          : {}),
        sourcePaths: Array.from(table.sourcePaths).sort((a, b) => a.localeCompare(b)),
        columns: Array.from(table.columns.entries())
          .map(([name, value]) => ({
            name,
            type: value.type,
            nullable: value.nullable,
            ...(value.expandableReference ? { expandableReference: true } : {}),
            ...(value.referenceResourceIds.size > 0
              ? {
                  referenceResourceIds: Array.from(value.referenceResourceIds).sort((a, b) =>
                    a.localeCompare(b)
                  ),
                }
              : {}),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))

    return {
      apiVersion: spec.info?.version ?? spec.openapi ?? 'unknown',
      tables,
    }
  }

  private collectBackedResourceIds(
    spec: OpenApiSpec,
    resourceScope: NonNullable<ParseSpecOptions['resourceScope']>
  ): Map<string, BackedResourceAccumulator> {
    if (resourceScope === 'resource_id_backed') {
      return this.collectResourceIdBackedResourceIds(spec)
    }

    const resourceIds = new Map<string, BackedResourceAccumulator>()
    const shouldUseCollectionOnly = resourceScope === 'collection_backed'
    const shouldUseGetOnly =
      resourceScope === 'collection_backed' || resourceScope === 'get_backed'
    const shouldUseListResponseExtraction = resourceScope === 'collection_backed'

    for (const [pathName, pathItem] of Object.entries(spec.paths ?? {})) {
      if (shouldUseCollectionOnly && !this.isCollectionPath(pathName)) {
        continue
      }

      const operations: Array<[string, OpenApiOperationObject]> =
        shouldUseGetOnly
          ? pathItem?.get
            ? [['get', pathItem.get]]
            : []
          : Object.entries(pathItem ?? {}).filter(
              (entry): entry is [string, OpenApiOperationObject] => this.isOperationObject(entry[1])
            )

      for (const [methodName, operation] of operations) {
        if (shouldUseGetOnly && methodName !== 'get') {
          continue
        }

        for (const [statusCode, response] of Object.entries(operation.responses ?? {})) {
          if (!this.isSuccessfulResponseStatus(statusCode)) {
            continue
          }

          for (const mediaType of Object.values(response.content ?? {})) {
            const schema = mediaType.schema
            if (!schema) {
              continue
            }

            const responseResourceIds =
              shouldUseListResponseExtraction
                ? this.collectListResponseResourceIds(schema, spec)
                : this.collectResponseResourceIds(schema, spec)

            for (const resourceId of responseResourceIds) {
              const entry = resourceIds.get(resourceId) ?? { sourcePaths: new Set<string>() }
              entry.sourcePaths.add(pathName)
              resourceIds.set(resourceId, entry)
            }
          }
        }
      }
    }

    if (resourceScope === 'get_backed') {
      for (const [resourceId, operationBacked] of this.collectGetOperationBackedResourceIds(spec)) {
        const entry = resourceIds.get(resourceId) ?? { sourcePaths: new Set<string>() }
        for (const sourcePath of operationBacked.sourcePaths) {
          entry.sourcePaths.add(sourcePath)
        }
        resourceIds.set(resourceId, entry)
      }

      for (const resourceId of Array.from(resourceIds.keys())) {
        if (this.isDeletedResourceId(resourceId)) {
          resourceIds.delete(resourceId)
        }
      }
    }

    return resourceIds
  }

  private collectGetOperationBackedResourceIds(
    spec: OpenApiSpec
  ): Map<string, BackedResourceAccumulator> {
    const resourceIds = new Map<string, BackedResourceAccumulator>()

    for (const [schemaName, schemaOrRef] of Object.entries(spec.components?.schemas ?? {})) {
      const schema = this.resolveSchema(
        this.isReference(schemaOrRef) ? schemaOrRef : { $ref: `#/components/schemas/${schemaName}` },
        spec
      )
      const resourceId = schema['x-resourceId']
      if (!resourceId || typeof resourceId !== 'string') {
        continue
      }

      const getPaths = new Set<string>()
      for (const operation of schema['x-stripeOperations'] ?? []) {
        const pathName = typeof operation?.path === 'string' ? operation.path : null
        if (!pathName || !spec.paths?.[pathName]?.get) {
          continue
        }
        getPaths.add(pathName)
      }

      if (getPaths.size === 0) {
        continue
      }

      const entry = resourceIds.get(resourceId) ?? { sourcePaths: new Set<string>() }
      for (const pathName of getPaths) {
        entry.sourcePaths.add(pathName)
      }
      resourceIds.set(resourceId, entry)
    }

    return resourceIds
  }

  private collectResourceIdBackedResourceIds(
    spec: OpenApiSpec
  ): Map<string, BackedResourceAccumulator> {
    const resourceIds = new Map<string, BackedResourceAccumulator>()

    for (const [schemaName, schemaOrRef] of Object.entries(spec.components?.schemas ?? {})) {
      const schema = this.resolveSchema(
        this.isReference(schemaOrRef) ? schemaOrRef : { $ref: `#/components/schemas/${schemaName}` },
        spec
      )
      const resourceId = schema['x-resourceId']
      if (!resourceId || typeof resourceId !== 'string') {
        continue
      }

      const entry = resourceIds.get(resourceId) ?? { sourcePaths: new Set<string>() }
      for (const operation of schema['x-stripeOperations'] ?? []) {
        if (typeof operation?.path === 'string' && operation.path.length > 0) {
          entry.sourcePaths.add(operation.path)
        }
      }
      resourceIds.set(resourceId, entry)
    }

    return resourceIds
  }

  private isCollectionPath(pathName: string): boolean {
    return !/\/\{[^/]+\}$/.test(pathName)
  }

  private isSuccessfulResponseStatus(statusCode: string): boolean {
    return /^2\d\d$/.test(statusCode)
  }

  private isDeletedResourceId(resourceId: string): boolean {
    return resourceId.startsWith('deleted_')
  }

  private resolveTableName(resourceId: string, aliases: Record<string, string>): string {
    const alias = aliases[resourceId]
    if (alias) {
      return alias
    }

    const normalized = resourceId.toLowerCase().replace(/[.]/g, '_')
    return normalized.endsWith('s') ? normalized : `${normalized}s`
  }

  private parseColumns(
    propCandidates: Map<string, OpenApiSchemaOrReference[]>,
    spec: OpenApiSpec
  ): ParsedColumn[] {
    const columns: ParsedColumn[] = []
    for (const [propertyName, candidates] of Array.from(propCandidates.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      if (RESERVED_COLUMNS.has(propertyName)) {
        continue
      }
      const inferred = this.inferFromCandidates(candidates, spec)
      columns.push({
        name: propertyName,
        type: inferred.type,
        nullable: inferred.nullable,
        ...(inferred.expandableReference ? { expandableReference: true } : {}),
        ...(inferred.referenceResourceIds
          ? { referenceResourceIds: inferred.referenceResourceIds }
          : {}),
      })
    }
    return columns
  }

  private collectResponseResourceIds(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec,
    seenRefs = new Set<string>(),
    seenSchemas = new Set<OpenApiSchemaObject>()
  ): Set<string> {
    const collect = (
      candidate: OpenApiSchemaOrReference,
      candidateSeenRefs: Set<string>,
      candidateSeenSchemas: Set<OpenApiSchemaObject>
    ): Set<string> => {
      if (this.isReference(candidate)) {
        if (candidateSeenRefs.has(candidate.$ref)) {
          return new Set()
        }
        candidateSeenRefs.add(candidate.$ref)
      }

      const schema = this.resolveSchema(candidate, spec)
      if (candidateSeenSchemas.has(schema)) {
        return new Set()
      }
      candidateSeenSchemas.add(schema)

      const resourceIds = new Set<string>()
      const directResourceId = schema['x-resourceId']
      const hasDirectResourceId = typeof directResourceId === 'string'
      if (hasDirectResourceId) {
        resourceIds.add(directResourceId)
      }

      if (!hasDirectResourceId) {
        if (schema.type === 'array' && schema.items) {
          for (const resourceId of collect(
            schema.items,
            new Set(candidateSeenRefs),
            new Set(candidateSeenSchemas)
          )) {
            resourceIds.add(resourceId)
          }
        }

        const dataSchema = schema.properties?.data
        if (dataSchema) {
          for (const resourceId of collect(
            dataSchema,
            new Set(candidateSeenRefs),
            new Set(candidateSeenSchemas)
          )) {
            resourceIds.add(resourceId)
          }
        }
      }

      for (const composed of [schema.oneOf, schema.anyOf, schema.allOf]) {
        if (!composed) {
          continue
        }

        for (const subSchema of composed) {
          for (const resourceId of collect(
            subSchema,
            new Set(candidateSeenRefs),
            new Set(candidateSeenSchemas)
          )) {
            resourceIds.add(resourceId)
          }
        }
      }

      return resourceIds
    }

    return collect(schemaOrRef, seenRefs, seenSchemas)
  }

  private collectListResponseResourceIds(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec
  ): Set<string> {
    const collect = (
      candidate: OpenApiSchemaOrReference,
      seenRefs = new Set<string>(),
      seenSchemas = new Set<OpenApiSchemaObject>()
    ): Set<string> => {
      if (this.isReference(candidate)) {
        if (seenRefs.has(candidate.$ref)) {
          return new Set()
        }
        seenRefs.add(candidate.$ref)
      }

      const schema = this.resolveSchema(candidate, spec)
      if (seenSchemas.has(schema)) {
        return new Set()
      }
      seenSchemas.add(schema)

      const resourceIds = new Set<string>()
      const dataSchema = schema.properties?.data
      if (dataSchema) {
        for (const resourceId of this.collectListItemResourceIds(
          dataSchema,
          spec,
          new Set(seenRefs),
          new Set(seenSchemas)
        )) {
          resourceIds.add(resourceId)
        }
      }

      for (const composed of [schema.oneOf, schema.anyOf, schema.allOf]) {
        if (!composed) {
          continue
        }

        for (const subSchema of composed) {
          for (const resourceId of collect(subSchema, new Set(seenRefs), new Set(seenSchemas))) {
            resourceIds.add(resourceId)
          }
        }
      }

      return resourceIds
    }

    return collect(schemaOrRef)
  }

  private collectListItemResourceIds(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec,
    seenRefs = new Set<string>(),
    seenSchemas = new Set<OpenApiSchemaObject>()
  ): Set<string> {
    const collect = (
      candidate: OpenApiSchemaOrReference,
      candidateSeenRefs: Set<string>,
      candidateSeenSchemas: Set<OpenApiSchemaObject>
    ): Set<string> => {
      if (this.isReference(candidate)) {
        if (candidateSeenRefs.has(candidate.$ref)) {
          return new Set()
        }
        candidateSeenRefs.add(candidate.$ref)
      }

      const schema = this.resolveSchema(candidate, spec)
      if (candidateSeenSchemas.has(schema)) {
        return new Set()
      }
      candidateSeenSchemas.add(schema)

      if (schema.type === 'array' && schema.items) {
        return this.collectResourceIdsFromItemSchema(
          schema.items,
          spec,
          new Set(candidateSeenRefs),
          new Set(candidateSeenSchemas)
        )
      }

      const resourceIds = new Set<string>()
      for (const composed of [schema.oneOf, schema.anyOf, schema.allOf]) {
        if (!composed) {
          continue
        }

        for (const subSchema of composed) {
          for (const resourceId of collect(
            subSchema,
            new Set(candidateSeenRefs),
            new Set(candidateSeenSchemas)
          )) {
            resourceIds.add(resourceId)
          }
        }
      }

      return resourceIds
    }

    return collect(schemaOrRef, seenRefs, seenSchemas)
  }

  private collectResourceIdsFromItemSchema(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec,
    seenRefs = new Set<string>(),
    seenSchemas = new Set<OpenApiSchemaObject>()
  ): Set<string> {
    const collect = (
      candidate: OpenApiSchemaOrReference,
      candidateSeenRefs: Set<string>,
      candidateSeenSchemas: Set<OpenApiSchemaObject>
    ): Set<string> => {
      if (this.isReference(candidate)) {
        if (candidateSeenRefs.has(candidate.$ref)) {
          return new Set()
        }
        candidateSeenRefs.add(candidate.$ref)
      }

      const schema = this.resolveSchema(candidate, spec)
      if (candidateSeenSchemas.has(schema)) {
        return new Set()
      }
      candidateSeenSchemas.add(schema)

      const resourceIds = new Set<string>()
      const resourceId = schema['x-resourceId']
      if (typeof resourceId === 'string') {
        resourceIds.add(resourceId)
      }

      for (const composed of [schema.oneOf, schema.anyOf, schema.allOf]) {
        if (!composed) {
          continue
        }

        for (const subSchema of composed) {
          for (const composedResourceId of collect(
            subSchema,
            new Set(candidateSeenRefs),
            new Set(candidateSeenSchemas)
          )) {
            resourceIds.add(composedResourceId)
          }
        }
      }

      return resourceIds
    }

    return collect(schemaOrRef, seenRefs, seenSchemas)
  }

  private inferFromCandidates(
    candidates: OpenApiSchemaOrReference[],
    spec: OpenApiSpec
  ): {
    type: ScalarType
    nullable: boolean
    expandableReference: boolean
    referenceResourceIds?: string[]
  } {
    if (candidates.length === 0) {
      return { type: 'text', nullable: true, expandableReference: false }
    }

    let mergedType: ScalarType | null = null
    let nullable = false
    let expandableReference = false
    const referenceResourceIds = new Set<string>()
    for (const candidate of candidates) {
      const inferred = this.inferType(candidate, spec)
      const candidateReferenceIds = this.collectExpandableReferenceResourceIds(candidate, spec)
      mergedType = mergedType ? this.mergeTypes(mergedType, inferred.type) : inferred.type
      nullable = nullable || inferred.nullable
      expandableReference = expandableReference || candidateReferenceIds.size > 0
      for (const referenceResourceId of candidateReferenceIds) {
        referenceResourceIds.add(referenceResourceId)
      }
    }

    return {
      type: mergedType ?? 'text',
      nullable,
      expandableReference,
      ...(referenceResourceIds.size > 0
        ? {
            referenceResourceIds: Array.from(referenceResourceIds).sort((a, b) =>
              a.localeCompare(b)
            ),
          }
        : {}),
    }
  }

  private mergeTypes(left: ScalarType, right: ScalarType): ScalarType {
    if (left === right) return left
    if (left === 'json' || right === 'json') return 'json'
    if ((left === 'numeric' && right === 'bigint') || (left === 'bigint' && right === 'numeric')) {
      return 'numeric'
    }
    if (left === 'timestamptz' && right === 'text') return 'text'
    if (left === 'text' && right === 'timestamptz') return 'text'
    return 'text'
  }

  private inferType(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec
  ): { type: ScalarType; nullable: boolean } {
    const schema = this.resolveSchema(schemaOrRef, spec)
    const nullable = Boolean(schema.nullable)

    if (schema.oneOf?.length) {
      const merged = this.inferFromCandidates(schema.oneOf, spec)
      return { type: merged.type, nullable: nullable || merged.nullable }
    }
    if (schema.anyOf?.length) {
      const merged = this.inferFromCandidates(schema.anyOf, spec)
      return { type: merged.type, nullable: nullable || merged.nullable }
    }
    if (schema.allOf?.length) {
      const merged = this.inferFromCandidates(schema.allOf, spec)
      return { type: merged.type, nullable: nullable || merged.nullable }
    }

    if (schema.type === 'boolean') return { type: 'boolean', nullable }
    if (schema.type === 'integer') return { type: 'bigint', nullable }
    if (schema.type === 'number') return { type: 'numeric', nullable }
    if (schema.type === 'string') {
      if (schema.format === 'date-time') {
        return { type: 'timestamptz', nullable }
      }
      return { type: 'text', nullable }
    }
    if (schema.type === 'array') return { type: 'json', nullable }
    if (schema.type === 'object') return { type: 'json', nullable }
    if (schema.properties || schema.additionalProperties) return { type: 'json', nullable }

    if (schema.enum && schema.enum.length > 0) {
      const values = schema.enum
      if (values.every((value) => typeof value === 'boolean')) {
        return { type: 'boolean', nullable }
      }
      if (values.every((value) => typeof value === 'number' && Number.isInteger(value))) {
        return { type: 'bigint', nullable }
      }
      if (values.every((value) => typeof value === 'number')) {
        return { type: 'numeric', nullable }
      }
    }

    return { type: 'text', nullable: true }
  }

  private collectExpandableReferenceResourceIds(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec,
    seenRefs = new Set<string>(),
    seenSchemas = new Set<OpenApiSchemaObject>()
  ): Set<string> {
    const collect = (
      candidate: OpenApiSchemaOrReference,
      candidateSeenRefs: Set<string>,
      candidateSeenSchemas: Set<OpenApiSchemaObject>
    ): Set<string> => {
      if (this.isReference(candidate)) {
        if (candidateSeenRefs.has(candidate.$ref)) {
          return new Set()
        }
        candidateSeenRefs.add(candidate.$ref)
      }

      const schema = this.resolveSchema(candidate, spec)
      if (candidateSeenSchemas.has(schema)) {
        return new Set()
      }
      candidateSeenSchemas.add(schema)

      const resourceIds = new Set<string>()
      for (const expansionCandidate of schema['x-expansionResources']?.oneOf ?? []) {
        for (const resourceId of this.collectResourceIdsFromItemSchema(
          expansionCandidate,
          spec,
          new Set(candidateSeenRefs),
          new Set(candidateSeenSchemas)
        )) {
          resourceIds.add(resourceId)
        }
      }

      for (const composed of [schema.oneOf, schema.anyOf, schema.allOf]) {
        if (!composed) {
          continue
        }

        for (const subSchema of composed) {
          for (const resourceId of collect(
            subSchema,
            new Set(candidateSeenRefs),
            new Set(candidateSeenSchemas)
          )) {
            resourceIds.add(resourceId)
          }
        }
      }

      return resourceIds
    }

    return collect(schemaOrRef, seenRefs, seenSchemas)
  }

  private collectPropertyCandidates(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec,
    seenRefs = new Set<string>(),
    seenSchemas = new Set<OpenApiSchemaObject>()
  ): Map<string, OpenApiSchemaOrReference[]> {
    if (this.isReference(schemaOrRef)) {
      if (seenRefs.has(schemaOrRef.$ref)) {
        return new Map()
      }
      seenRefs.add(schemaOrRef.$ref)
    }

    const schema = this.resolveSchema(schemaOrRef, spec)
    if (seenSchemas.has(schema)) {
      return new Map()
    }
    seenSchemas.add(schema)

    const merged = new Map<string, OpenApiSchemaOrReference[]>()
    const pushProp = (name: string, value: OpenApiSchemaOrReference) => {
      const existing = merged.get(name) ?? []
      existing.push(value)
      merged.set(name, existing)
    }

    for (const [name, value] of Object.entries(schema.properties ?? {})) {
      pushProp(name, value)
    }

    for (const composed of [schema.allOf, schema.oneOf, schema.anyOf]) {
      if (!composed) continue
      for (const subSchema of composed) {
        const subProps = this.collectPropertyCandidates(subSchema, spec, seenRefs, seenSchemas)
        for (const [name, candidates] of subProps.entries()) {
          for (const candidate of candidates) {
            pushProp(name, candidate)
          }
        }
      }
    }

    return merged
  }

  private resolveSchema(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec
  ): OpenApiSchemaObject {
    if (!this.isReference(schemaOrRef)) {
      return schemaOrRef
    }

    const prefix = '#/components/schemas/'
    if (!schemaOrRef.$ref.startsWith(prefix)) {
      throw new Error(`Unsupported OpenAPI reference: ${schemaOrRef.$ref}`)
    }
    const schemaName = schemaOrRef.$ref.slice(prefix.length)
    const resolved = spec.components?.schemas?.[schemaName]
    if (!resolved) {
      throw new Error(`Failed to resolve OpenAPI schema reference: ${schemaOrRef.$ref}`)
    }
    if (this.isReference(resolved)) {
      return this.resolveSchema(resolved, spec)
    }
    return resolved
  }

  private isReference(schemaOrRef: OpenApiSchemaOrReference): schemaOrRef is { $ref: string } {
    return typeof (schemaOrRef as { $ref?: string }).$ref === 'string'
  }

  private isOperationObject(candidate: unknown): candidate is OpenApiOperationObject {
    return Boolean(candidate && typeof candidate === 'object' && 'responses' in candidate)
  }
}
