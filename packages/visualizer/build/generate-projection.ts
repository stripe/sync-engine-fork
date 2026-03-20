#!/usr/bin/env node
/**
 * Generate projection.json artifact from OpenAPI spec
 *
 * This build-time script parses the OpenAPI spec for a given API version
 * and generates a projection.json file containing enhanced metadata for
 * ERD visualization, including namespace classification, semantic tags,
 * relationship candidates, and deleted-variant metadata.
 *
 * Usage:
 *   pnpm tsx packages/visualizer/build/generate-projection.ts \
 *     --api-version=2025-01-27 \
 *     --output-dir=./packages/visualizer/public/explorer-data/2025-01-27
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  OPENAPI_RESOURCE_TABLE_ALIASES,
  SpecParser,
  buildResourceSupportProfiles,
  resolveOpenApiSpec,
} from '../../sync-engine/src/openapi'
import type { ParsedResourceTable, ScalarType } from '../../sync-engine/src/openapi/types'
import type { ResourceSupportProfile } from '../../sync-engine/src/openapi/resourceSupport'
import type {
  ProjectionArtifact,
  ProjectionTable,
  ProjectionColumn,
  LogicalType,
  SemanticTag,
  ProjectionRelationship,
  RelationshipConfidence,
  DeletedVariantMetadata,
} from '../src/types/projection'
import { resolveProjectionDisplayName } from '../src/lib/projection-display-names'
import { determineNamespace } from '../src/lib/projection-namespace'

interface Args {
  apiVersion: string
  outputDir: string
}

const __filename = fileURLToPath(import.meta.url)

type ProjectionBuildContext = {
  aliases: Record<string, string>
  allTableNames: Set<string>
  resourceIdToTableName: Map<string, string>
}

export type ProjectionArtifactBuildInput = {
  apiVersion: string
  parsedTables: ParsedResourceTable[]
  deletedParsedTables?: ParsedResourceTable[]
  resourceSupportProfiles: Map<string, ResourceSupportProfile>
  generatedAt?: string
}

/**
 * Parse command-line arguments
 */
function parseArgs(): Args {
  const args = process.argv.slice(2)
  let apiVersion: string | undefined
  let outputDir: string | undefined

  for (const arg of args) {
    if (arg.startsWith('--api-version=')) {
      apiVersion = arg.split('=')[1]
    } else if (arg.startsWith('--output-dir=')) {
      outputDir = arg.split('=')[1]
    }
  }

  if (!apiVersion) {
    throw new Error('Missing required argument: --api-version=YYYY-MM-DD')
  }

  if (!outputDir) {
    throw new Error('Missing required argument: --output-dir=/path/to/output')
  }

  return { apiVersion, outputDir }
}

function getParsedResourceIds(parsedTable: ParsedResourceTable): string[] {
  return parsedTable.resourceIds?.length ? parsedTable.resourceIds : [parsedTable.resourceId]
}

function getParsedSourceSchemaNames(parsedTable: ParsedResourceTable): string[] {
  return parsedTable.sourceSchemaNames?.length
    ? parsedTable.sourceSchemaNames
    : [parsedTable.sourceSchemaName]
}

function isDeletedResourceId(resourceId: string): boolean {
  return resourceId.startsWith('deleted_')
}

function toLiveResourceId(resourceId: string): string {
  return resourceId.replace(/^deleted_/, '')
}

function pickPrimaryResourceId(parsedTable: ParsedResourceTable): string {
  const resourceIds = getParsedResourceIds(parsedTable)
  return resourceIds.find((resourceId) => !isDeletedResourceId(resourceId)) ?? parsedTable.resourceId
}

function pickFamilyKey(parsedTable: ParsedResourceTable): string {
  const primaryResourceId = pickPrimaryResourceId(parsedTable)
  return isDeletedResourceId(primaryResourceId) ? toLiveResourceId(primaryResourceId) : primaryResourceId
}

function buildProjectionContext(parsedTables: ParsedResourceTable[]): ProjectionBuildContext {
  const allTableNames = new Set(parsedTables.map((table) => table.tableName))
  const resourceIdToTableName = new Map<string, string>()

  for (const parsedTable of parsedTables) {
    for (const resourceId of getParsedResourceIds(parsedTable)) {
      resourceIdToTableName.set(resourceId, parsedTable.tableName)
    }
  }

  return {
    aliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    allTableNames,
    resourceIdToTableName,
  }
}

function deriveTableSupport(
  resourceIds: string[] | undefined,
  resourceSupportProfiles: Map<string, ResourceSupportProfile>
): Pick<ProjectionTable, 'hasListEndpoint' | 'hasWebhookEvent'> {
  const liveResourceIds = Array.from(
    new Set((resourceIds ?? []).map((resourceId) => toLiveResourceId(resourceId)))
  )

  return {
    hasListEndpoint: liveResourceIds.some(
      (resourceId) => resourceSupportProfiles.get(resourceId)?.hasListEndpoint === true
    ),
    hasWebhookEvent: liveResourceIds.some(
      (resourceId) => resourceSupportProfiles.get(resourceId)?.hasWebhookEvent === true
    ),
  }
}

/**
 * Preserve the underlying SQL-ish type for raw display.
 */
function mapToMaterializedType(scalarType: ScalarType, expandableReference: boolean): string {
  if (expandableReference) {
    return 'text'
  }

  return scalarType
}

/**
 * Map ScalarType from sync-engine to LogicalType for projection.
 * Raw integer timestamps stay distinguishable from generic numbers so the
 * visualizer can flip them to timestamptz on demand.
 */
function mapToLogicalType(
  scalarType: ScalarType,
  semanticTags: SemanticTag[],
  expandableReference: boolean
): LogicalType {
  if (expandableReference) {
    return 'string'
  }

  if (semanticTags.includes('timestamp')) {
    if (scalarType === 'timestamptz') {
      return 'timestamptz'
    }

    if (scalarType === 'bigint' || scalarType === 'numeric') {
      return 'timestamp'
    }
  }

  switch (scalarType) {
    case 'text':
      return 'string'
    case 'boolean':
      return 'boolean'
    case 'bigint':
      return 'number'
    case 'numeric':
      return 'number'
    case 'json':
      return 'json'
    case 'timestamptz':
      return 'timestamptz'
    default:
      return 'unknown'
  }
}

/**
 * Determine semantic tags for a column
 */
function inferSemanticTags(
  columnName: string,
  scalarType: ScalarType,
  expandableReference: boolean
): SemanticTag[] {
  const tags: SemanticTag[] = []

  // Primary key detection
  if (columnName === 'id') {
    tags.push('primary_key')
  }

  // Deleted flag detection
  if (columnName === 'deleted' && scalarType === 'boolean') {
    tags.push('soft_delete')
  }

  // Timestamp detection
  if (
    (scalarType === 'bigint' && columnName === 'created') ||
    scalarType === 'timestamptz' ||
    columnName.endsWith('_at') ||
    columnName === 'created'
  ) {
    tags.push('timestamp')
  }

  // Expandable reference detection
  if (expandableReference) {
    tags.push('expandable_ref')
    tags.push('foreign_key')
  }

  // Foreign key heuristic (column ends with _id or matches common FK patterns)
  if (!expandableReference && (columnName.endsWith('_id') || columnName === 'customer' || columnName === 'account')) {
    tags.push('foreign_key')
  }

  // Array detection (not directly from ScalarType but inferred from column naming)
  if (columnName.endsWith('s') && scalarType === 'json') {
    tags.push('array')
  }

  // Object detection
  if (scalarType === 'json' && !tags.includes('array')) {
    tags.push('object')
  }

  // Resource type discriminator
  if (columnName === 'object' && scalarType === 'text') {
    tags.push('resource_type')
  }

  // Metadata field
  if (columnName === 'metadata' && scalarType === 'json') {
    tags.push('metadata')
  }

  return tags
}

/**
 * Extract resource family key from column name for expandable references
 * e.g., "customer" -> "customer", "payment_intent" -> "payment_intent"
 */
function extractResourceFamilyKey(columnName: string): string {
  // For expandable references, the column name typically IS the resource family key
  return columnName
}

/**
 * Infer the target table name from a foreign key column
 * Uses pluralization heuristics
 */
function inferTargetTable(columnName: string): string | undefined {
  // Remove _id suffix if present
  let base = columnName.endsWith('_id') ? columnName.slice(0, -3) : columnName

  // Common pluralization rules
  const pluralizations: Record<string, string> = {
    customer: 'customers',
    account: 'accounts',
    charge: 'charges',
    payment_intent: 'payment_intents',
    payment_method: 'payment_methods',
    subscription: 'subscriptions',
    invoice: 'invoices',
    product: 'products',
    price: 'prices',
    refund: 'refunds',
    dispute: 'disputes',
    balance_transaction: 'balance_transactions',
    application_fee: 'application_fees',
    plan: 'plans',
    card: 'cards',
    bank_account: 'bank_accounts',
    source: 'sources',
    payout: 'payouts',
    review: 'reviews',
    feature: 'features',
  }

  if (pluralizations[base]) {
    return pluralizations[base]
  }

  // Default pluralization: add 's'
  return base + 's'
}

function selectPreferredReferenceResourceId(
  referenceResourceIds: string[],
  tableNamespace: ProjectionTable['namespace']
): string | undefined {
  const liveResourceIds = Array.from(
    new Set(referenceResourceIds.filter((resourceId) => !isDeletedResourceId(resourceId)))
  )
  if (liveResourceIds.length === 0) {
    return undefined
  }

  if (tableNamespace === 'v2') {
    return liveResourceIds.find((resourceId) => resourceId.startsWith('v2.')) ?? liveResourceIds[0]
  }

  if (tableNamespace === 'v1') {
    return liveResourceIds.find((resourceId) => !resourceId.startsWith('v2.')) ?? liveResourceIds[0]
  }

  return liveResourceIds[0]
}

function inferCandidateResourceIds(
  columnName: string,
  tableNamespace: ProjectionTable['namespace']
): string[] {
  const base = columnName.endsWith('_id') ? columnName.slice(0, -3) : columnName

  if (tableNamespace === 'v2') {
    return [`v2.core.${base}`, `v2.billing.${base}`, base]
  }

  return [base]
}

function resolveTargetTable(
  column: ParsedResourceTable['columns'][number],
  tableNamespace: ProjectionTable['namespace'],
  context: ProjectionBuildContext
): string | undefined {
  const explicitTargetResourceId = column.referenceResourceIds
    ? selectPreferredReferenceResourceId(column.referenceResourceIds, tableNamespace)
    : undefined
  if (explicitTargetResourceId) {
    const explicitTargetTable = context.resourceIdToTableName.get(explicitTargetResourceId)
    if (explicitTargetTable) {
      return explicitTargetTable
    }
  }

  for (const candidateResourceId of inferCandidateResourceIds(column.name, tableNamespace)) {
    const candidateTable = context.resourceIdToTableName.get(candidateResourceId)
    if (candidateTable) {
      return candidateTable
    }
  }

  const targetTable = inferTargetTable(column.name)
  if (targetTable && context.allTableNames.has(targetTable)) {
    return targetTable
  }

  return undefined
}

/**
 * Determine relationship confidence based on column characteristics
 */
function inferConfidence(
  columnName: string,
  expandableReference: boolean,
  nullable: boolean
): RelationshipConfidence {
  // High confidence for expandable references
  if (expandableReference) {
    return 'high'
  }

  // Medium confidence for explicit _id suffix
  if (columnName.endsWith('_id')) {
    return 'medium'
  }

  // Low confidence for nullable or ambiguous columns
  if (nullable || !columnName.match(/^(customer|account|.*_id)$/)) {
    return 'low'
  }

  return 'medium'
}

/**
 * Convert parsed table to projection table
 */
function convertToProjectionTable(
  parsedTable: ParsedResourceTable,
  context: ProjectionBuildContext,
  resourceSupportProfiles: Map<string, ResourceSupportProfile>
): ProjectionTable {
  const resourceIds = getParsedResourceIds(parsedTable)
  const sourceSchemaNames = getParsedSourceSchemaNames(parsedTable)
  const displayName = resolveProjectionDisplayName(parsedTable.tableName, resourceIds)
  const namespace = determineNamespace(
    parsedTable.sourcePaths,
    parsedTable.sourceSchemaName,
    parsedTable.tableName
  )

  const isCompatibilityOnly = namespace === 'compatibility'
  const familyKey = pickFamilyKey(parsedTable)
  const isDeletedVariant = resourceIds.some((resourceId) => isDeletedResourceId(resourceId))
  const { hasListEndpoint, hasWebhookEvent } = deriveTableSupport(
    resourceIds,
    resourceSupportProfiles
  )

  const columns: ProjectionColumn[] = parsedTable.columns.map((col) => {
    const semanticTags = inferSemanticTags(col.name, col.type, col.expandableReference ?? false)
    const logicalType = mapToLogicalType(col.type, semanticTags, col.expandableReference ?? false)

    const column: ProjectionColumn = {
      name: col.name,
      semanticTags,
      logicalType,
      materializedType: mapToMaterializedType(col.type, col.expandableReference ?? false),
      nullable: col.nullable,
      ...(col.referenceResourceIds ? { referenceResourceIds: col.referenceResourceIds } : {}),
    }

    // Add FK metadata for foreign key columns
    if (semanticTags.includes('foreign_key')) {
      const targetTable = resolveTargetTable(col, namespace, context)
      if (targetTable) {
        column.referencesTable = targetTable
        column.referencesColumn = 'id'
      }
    }

    // Add resource family key for expandable references
    if (semanticTags.includes('expandable_ref')) {
      const preferredReferenceResourceId = col.referenceResourceIds
        ? selectPreferredReferenceResourceId(col.referenceResourceIds, namespace)
        : undefined
      column.resourceFamilyKey = preferredReferenceResourceId
        ? toLiveResourceId(preferredReferenceResourceId)
        : extractResourceFamilyKey(col.name)
    }

    return column
  })

  const liveTableName = isDeletedVariant
    ? context.resourceIdToTableName.get(familyKey) ??
      context.aliases[familyKey] ??
      parsedTable.tableName.replace(/^deleted_/, '')
    : undefined

  return {
    tableName: parsedTable.tableName,
    ...(displayName !== parsedTable.tableName ? { displayName } : {}),
    namespace,
    familyKey,
    isCompatibilityOnly,
    isDeletedVariant,
    resourceIds,
    sourceSchemaName: parsedTable.sourceSchemaName,
    sourceSchemaNames,
    sourcePaths: parsedTable.sourcePaths,
    hasListEndpoint,
    hasWebhookEvent,
    columns,
    liveTableName,
  }
}

/**
 * Extract relationship candidates from projection tables
 */
function extractRelationships(tables: ProjectionTable[]): ProjectionRelationship[] {
  const relationships: ProjectionRelationship[] = []

  for (const table of tables) {
    for (const column of table.columns) {
      if (
        column.semanticTags.includes('foreign_key') &&
        column.referencesTable &&
        column.referencesColumn
      ) {
        const confidence = inferConfidence(
          column.name,
          column.semanticTags.includes('expandable_ref'),
          column.nullable
        )

        relationships.push({
          fromTable: table.tableName,
          fromColumn: column.name,
          toTable: column.referencesTable,
          toColumn: column.referencesColumn,
          confidence,
        })
      }
    }
  }

  return relationships
}

/**
 * Extract deleted variant metadata
 */
function extractDeletedVariants(
  liveTables: ProjectionTable[],
  deletedTables: ProjectionTable[]
): DeletedVariantMetadata[] {
  const variants: DeletedVariantMetadata[] = []
  const liveTableMap = new Map<string, ProjectionTable>()

  // Build map of live tables
  for (const table of liveTables) {
    if (!table.isDeletedVariant) {
      liveTableMap.set(table.tableName, table)
    }
  }

  // Find deleted variants and link them to live tables
  for (const table of deletedTables) {
    if (!table.isDeletedVariant || !table.liveTableName) {
      continue
    }

    const liveTable = liveTableMap.get(table.liveTableName)
    if (!liveTable || table.tableName === liveTable.tableName) {
      continue
    }

    const liveColumnNames = new Set(liveTable.columns.map((c) => c.name))
    const additionalColumns = table.columns
      .filter((c) => !liveColumnNames.has(c.name))
      .map((c) => c.name)

    const softDeleteColumn =
      liveTable.columns.find((c) => c.semanticTags.includes('soft_delete'))?.name ??
      table.columns.find((c) => c.semanticTags.includes('soft_delete') || c.name === 'deleted')
        ?.name

    variants.push({
      liveTableName: table.liveTableName,
      deletedTableName: table.tableName,
      familyKey: table.familyKey,
      additionalColumns,
      usesSoftDelete: !!softDeleteColumn,
      softDeleteColumn,
      columns: table.columns,
      namespace: table.namespace,
      ...(table.displayName ? { displayName: table.displayName } : {}),
      hasListEndpoint: table.hasListEndpoint,
      hasWebhookEvent: table.hasWebhookEvent,
    })
  }

  return variants.sort((left, right) => left.deletedTableName.localeCompare(right.deletedTableName))
}

/**
 * Generate projection artifact
 */
export function buildProjectionArtifactFromParsedTables({
  apiVersion,
  parsedTables,
  deletedParsedTables = [],
  resourceSupportProfiles,
  generatedAt,
}: ProjectionArtifactBuildInput): ProjectionArtifact {
  const context = buildProjectionContext([...parsedTables, ...deletedParsedTables])

  // Convert to projection tables
  const tables = parsedTables.map((t) =>
    convertToProjectionTable(t, context, resourceSupportProfiles)
  )
  const deletedTables = deletedParsedTables
    .map((t) => convertToProjectionTable(t, context, resourceSupportProfiles))
    .filter((table) => table.isDeletedVariant)

  // Extract relationships
  const relationships = extractRelationships(tables)

  // Extract deleted variants
  const deletedVariants = extractDeletedVariants(tables, deletedTables)

  // Compute capabilities
  const hasV2Namespace = tables.some((t) => t.namespace === 'v2')
  const hasDeletedVariants = deletedVariants.length > 0
  const timestampFormats = new Set<'raw' | 'timestamptz'>()

  for (const table of tables) {
    for (const col of table.columns) {
      if (col.semanticTags.includes('timestamp')) {
        if (col.logicalType === 'timestamptz') {
          timestampFormats.add('timestamptz')
        } else if (col.logicalType === 'timestamp') {
          timestampFormats.add('raw')
        }
      }
    }
  }

  const timestampFormat =
    timestampFormats.size === 2 ? 'mixed' : timestampFormats.has('raw') ? 'raw' : 'timestamptz'

  const artifact: ProjectionArtifact = {
    apiVersion,
    generatedAt: generatedAt ?? new Date().toISOString(),
    capabilities: {
      hasV2Namespace,
      hasExplicitForeignKeys: false, // sync-engine doesn't create explicit FK constraints
      hasDeletedVariants,
      hasListEndpointMetadata: Array.from(resourceSupportProfiles.values()).some(
        (profile) => profile.hasStripeOperations
      ),
      hasWebhookEventMetadata: Array.from(resourceSupportProfiles.values()).some(
        (profile) => profile.webhookEventTypes.length > 0
      ),
      timestampFormat,
      tableCount: tables.length,
      relationshipCount: relationships.length,
    },
    tables: Object.fromEntries(tables.map((t) => [t.tableName, t])),
    relationships,
    deletedVariants,
  }

  return artifact
}

async function generateProjection(apiVersion: string): Promise<ProjectionArtifact> {
  console.log(`Resolving OpenAPI spec for ${apiVersion}...`)
  const resolved = await resolveOpenApiSpec({ apiVersion })
  console.log(`Resolved spec from ${resolved.source}`)

  console.log('Parsing OpenAPI spec...')
  const parser = new SpecParser()
  const resourceSupportProfiles = buildResourceSupportProfiles(resolved.spec)
  const parsed = parser.parse(resolved.spec, {
    resourceScope: 'get_backed',
    resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
  })
  const resourceIdBackedParsed = parser.parse(resolved.spec, {
    resourceScope: 'resource_id_backed',
    resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
  })
  const deletedParsedTables = resourceIdBackedParsed.tables.filter((table) =>
    getParsedResourceIds(table).some((resourceId) => isDeletedResourceId(resourceId))
  )

  console.log(
    `Found ${parsed.tables.length} GET-retrievable tables and ${deletedParsedTables.length} deleted-resource variants`
  )

  return buildProjectionArtifactFromParsedTables({
    apiVersion,
    parsedTables: parsed.tables,
    deletedParsedTables,
    resourceSupportProfiles,
  })
}

/**
 * Main entry point
 */
async function main() {
  try {
    const args = parseArgs()

    console.log('Generating projection artifact...')
    console.log(`  API Version: ${args.apiVersion}`)
    console.log(`  Output Dir: ${args.outputDir}`)

    const artifact = await generateProjection(args.apiVersion)

    // Ensure output directory exists
    await fs.mkdir(args.outputDir, { recursive: true })

    // Write projection.json
    const outputPath = path.join(args.outputDir, 'projection.json')
    await fs.writeFile(outputPath, JSON.stringify(artifact, null, 2), 'utf8')

    console.log(`✓ Generated projection.json at ${outputPath}`)
    console.log(`  Tables: ${artifact.capabilities.tableCount}`)
    console.log(`  Relationships: ${artifact.capabilities.relationshipCount}`)
    console.log(`  Deleted Variants: ${artifact.deletedVariants.length}`)
    console.log(`  V2 Namespace: ${artifact.capabilities.hasV2Namespace ? 'Yes' : 'No'}`)
    console.log(`  Timestamp Format: ${artifact.capabilities.timestampFormat}`)
  } catch (error) {
    console.error('Failed to generate projection artifact:')
    console.error(error)
    process.exit(1)
  }
}

// Run if invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main()
}
