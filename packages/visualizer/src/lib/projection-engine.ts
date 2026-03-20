/**
 * Projection Derivation Engine
 *
 * Pure-function module that transforms a ProjectionArtifact and ProjectionConfig
 * into a visible ERD model. Handles namespace/list/webhook filtering, FK edge
 * inclusion, timestamp mode transformation, and deleted-table virtualization.
 *
 * No React dependencies - pure data transformation only.
 */

import type {
  ProjectionArtifact,
  ProjectionConfig,
  ProjectionTable,
  ProjectionColumn,
  ProjectionRelationship,
  DeletedVariantMetadata,
  NamespaceTag,
} from '@/types/projection'

/**
 * Projected ERD Model
 * The output of the projection engine - a filtered and transformed view
 * of the artifact ready for visualization
 */
export interface ProjectedERDModel {
  /**
   * Tables to render in the ERD (after filtering)
   * Keyed by table name for O(1) lookup
   */
  tables: Record<string, ProjectedTable>

  /**
   * Relationship edges to render (after FK mode filtering)
   */
  relationships: ProjectionRelationship[]

  /**
   * Metadata about the projection transformation
   */
  metadata: ProjectionMetadata
}

/**
 * Projected table with transformed columns
 * May differ from source ProjectionTable due to timestamp/deleted mode
 */
export interface ProjectedTable {
  /**
   * Table name in the PostgreSQL schema
   */
  tableName: string

  /**
   * Human-facing ERD label for this table.
   */
  displayName?: string

  /**
   * API version namespace classification
   */
  namespace: NamespaceTag

  /**
   * Stripe API resource family key
   */
  familyKey: string

  /**
   * Whether this is a compatibility-only table
   */
  isCompatibilityOnly: boolean

  /**
   * Whether this is a deleted-resource variant table
   */
  isDeletedVariant: boolean

  /**
   * Whether this is a synthesized virtual table (from deletedMode='table')
   */
  isVirtual: boolean

  /**
   * OpenAPI support heuristic: exactly one canonical list endpoint.
   */
  hasListEndpoint: boolean

  /**
   * OpenAPI support heuristic: at least one mapped webhook event.
   */
  hasWebhookEvent: boolean

  /**
   * Columns to display (may be transformed)
   */
  columns: ProjectionColumn[]

  /**
   * For deleted-variant tables: the primary live table name
   */
  liveTableName?: string

  /**
   * Number of rows in this table
   */
  rowCount?: number
}

/**
 * Metadata about the projection transformation
 * Useful for debugging and UI hints
 */
export interface ProjectionMetadata {
  /**
   * Total tables in artifact before filtering
   */
  totalTables: number

  /**
   * Tables visible after filtering
   */
  visibleTables: number

  /**
   * Total relationships in artifact
   */
  totalRelationships: number

  /**
   * Relationships visible after filtering
   */
  visibleRelationships: number

  /**
   * Number of virtual deleted tables synthesized
   */
  virtualTablesAdded: number

  /**
   * Number of timestamp columns transformed
   */
  timestampColumnsTransformed: number

  /**
   * Number of deleted flag columns removed
   */
  deletedFlagsRemoved: number

  /**
   * Applied projection config
   */
  appliedConfig: ProjectionConfig
}

/**
 * Main projection engine entry point
 *
 * Takes a ProjectionArtifact and ProjectionConfig and derives the visible
 * ERD model by applying namespace/support filtering, FK mode, timestamp mode,
 * and deleted mode transformations.
 *
 * @param artifact - The projection artifact to transform
 * @param config - The projection configuration to apply
 * @returns A projected ERD model ready for visualization
 */
export function deriveProjectedModel(
  artifact: ProjectionArtifact,
  config: ProjectionConfig
): ProjectedERDModel {
  const metadata: ProjectionMetadata = {
    totalTables: Object.keys(artifact.tables).length,
    visibleTables: 0,
    totalRelationships: artifact.relationships.length,
    visibleRelationships: 0,
    virtualTablesAdded: 0,
    timestampColumnsTransformed: 0,
    deletedFlagsRemoved: 0,
    appliedConfig: config,
  }

  // Step 1: Apply table filters to get visible tables
  const filteredTables = filterTables(artifact, config)

  // Step 2: Apply timestamp mode transformations
  const transformedTables = applyTimestampMode(filteredTables, config, metadata)

  // Step 3: Apply deleted mode transformations
  const tablesWithDeletedMode = applyDeletedMode(transformedTables, artifact, config, metadata)

  // Step 4: Filter relationships based on FK mode and visible tables
  const filteredRelationships = filterRelationships(
    artifact.relationships,
    tablesWithDeletedMode,
    config,
    metadata
  )

  metadata.visibleTables = Object.keys(tablesWithDeletedMode).length
  metadata.visibleRelationships = filteredRelationships.length

  return {
    tables: tablesWithDeletedMode,
    relationships: filteredRelationships,
    metadata,
  }
}

/**
 * Step 1: Filter tables by namespace + support heuristics.
 */
function filterTables(
  artifact: ProjectionArtifact,
  config: ProjectionConfig
): Record<string, ProjectionTable> {
  const filtered: Record<string, ProjectionTable> = {}

  for (const [tableName, table] of Object.entries(artifact.tables)) {
    if (!shouldIncludeTableByNamespace(table, config)) {
      continue
    }

    if (!shouldIncludeTableBySupportFilters(table, artifact, config)) {
      continue
    }

    if (config.deletedMode === 'column' && table.isDeletedVariant) {
      continue
    }

    filtered[tableName] = table
  }

  return filtered
}

/**
 * Check if a table should be included based on namespace mode
 */
function shouldIncludeTableByNamespace(table: ProjectionTable, config: ProjectionConfig): boolean {
  switch (config.namespaceMode) {
    case 'v1':
      return table.namespace === 'v1'

    case 'v2':
      return table.namespace === 'v2'

    case 'both':
      return table.namespace === 'v1' || table.namespace === 'v2'

    default:
      return false
  }
}

function shouldIncludeTableBySupportFilters(
  table: ProjectionTable,
  artifact: ProjectionArtifact,
  config: ProjectionConfig
): boolean {
  if (config.listEndpointMode === 'either' && config.webhookEventMode === 'either') {
    return true
  }

  if (
    artifact.capabilities.hasListEndpointMetadata &&
    config.listEndpointMode === 'yes' &&
    !table.hasListEndpoint
  ) {
    return false
  }

  if (
    artifact.capabilities.hasListEndpointMetadata &&
    config.listEndpointMode === 'no' &&
    table.hasListEndpoint
  ) {
    return false
  }

  if (
    artifact.capabilities.hasWebhookEventMetadata &&
    config.webhookEventMode === 'yes' &&
    !table.hasWebhookEvent
  ) {
    return false
  }

  if (
    artifact.capabilities.hasWebhookEventMetadata &&
    config.webhookEventMode === 'no' &&
    table.hasWebhookEvent
  ) {
    return false
  }

  return true
}

/**
 * Step 2: Apply timestamp mode transformations
 *
 * When timestampMode is 'timestamptz':
 * - Transform v1 'created' columns from bigint (timestamp) to timestamptz
 * - Only affects display type, not data structure
 */
function applyTimestampMode(
  tables: Record<string, ProjectionTable>,
  config: ProjectionConfig,
  metadata: ProjectionMetadata
): Record<string, ProjectedTable> {
  const transformed: Record<string, ProjectedTable> = {}

  for (const [tableName, table] of Object.entries(tables)) {
    const projectedTable: ProjectedTable = {
      ...table,
      isVirtual: false,
      columns: [...table.columns],
    }

    // Only apply timestamp transformation if mode is 'timestamptz'
    if (config.timestampMode === 'timestamptz') {
      projectedTable.columns = table.columns.map((col) => {
        // Promote raw timestamps to timestamptz for ERD exploration.
        if (col.logicalType === 'timestamp' && col.semanticTags.includes('timestamp')) {
          metadata.timestampColumnsTransformed++
          return {
            ...col,
            logicalType: 'timestamptz',
          }
        }
        return col
      })
    }

    transformed[tableName] = projectedTable
  }

  return transformed
}

/**
 * Step 3: Apply deleted mode transformations
 *
 * When deletedMode is 'table':
 * - Show real deleted-resource tables from the artifact
 * - Remove the live table's deleted flag column when a real deleted-resource
 *   table is visible for that family
 *
 * When deletedMode is 'column':
 * - Keep deleted flag in base table
 * - Don't show deleted-variant tables (already filtered in step 1)
 */
function applyDeletedMode(
  tables: Record<string, ProjectedTable>,
  artifact: ProjectionArtifact,
  config: ProjectionConfig,
  metadata: ProjectionMetadata
): Record<string, ProjectedTable> {
  const result: Record<string, ProjectedTable> = { ...tables }

  if (config.deletedMode === 'column') {
    for (const deletedVariant of artifact.deletedVariants) {
      const { liveTableName, softDeleteColumn } = deletedVariant
      const liveTable = result[liveTableName]

      if (!liveTable) {
        continue
      }

      const existingDeletedColumn = findSoftDeleteColumn(liveTable)
      if (existingDeletedColumn) {
        continue
      }

      const sourceDeletedColumn = findSoftDeleteColumn(
        { columns: getDeletedVariantColumns(artifact, deletedVariant) },
        softDeleteColumn
      )

      if (!sourceDeletedColumn) {
        continue
      }

      result[liveTableName] = {
        ...liveTable,
        columns: sortColumnsByName([
          ...liveTable.columns,
          {
            ...sourceDeletedColumn,
            name: softDeleteColumn ?? sourceDeletedColumn.name,
            nullable: true,
            generated: true,
          },
        ]),
      }
    }
  }

  if (config.deletedMode === 'table') {
    for (const deletedVariant of artifact.deletedVariants) {
      const { liveTableName, deletedTableName, softDeleteColumn } = deletedVariant
      const liveTable = result[liveTableName]
      const deletedTable = result[deletedTableName]
      const deletedColumns = getDeletedVariantColumns(artifact, deletedVariant)

      if (!liveTable || deletedTableName === liveTableName) {
        continue
      }

      if (!deletedTable && deletedColumns.length > 0) {
        result[deletedTableName] = {
          tableName: deletedTableName,
          displayName: deletedVariant.displayName ?? deletedTableName,
          namespace: deletedVariant.namespace ?? liveTable.namespace,
          familyKey: deletedVariant.familyKey,
          isCompatibilityOnly: false,
          isDeletedVariant: true,
          isVirtual: true,
          hasListEndpoint: deletedVariant.hasListEndpoint ?? liveTable.hasListEndpoint,
          hasWebhookEvent: deletedVariant.hasWebhookEvent ?? liveTable.hasWebhookEvent,
          columns: sortColumnsByName(deletedColumns.map((column) => ({ ...column }))),
          liveTableName,
        }
        metadata.virtualTablesAdded++
      }

      const liveSoftDeleteColumn = softDeleteColumn
        ? findSoftDeleteColumn(liveTable, softDeleteColumn)
        : findSoftDeleteColumn(liveTable)

      if (liveSoftDeleteColumn) {
        result[liveTableName] = {
          ...liveTable,
          columns: liveTable.columns.filter(
            (col) =>
              col.name !== liveSoftDeleteColumn.name && !col.semanticTags.includes('soft_delete')
          ),
        }
        metadata.deletedFlagsRemoved++
      }
    }
  }

  return result
}

function getDeletedVariantColumns(
  artifact: ProjectionArtifact,
  deletedVariant: DeletedVariantMetadata
): ProjectionColumn[] {
  return deletedVariant.columns ?? artifact.tables[deletedVariant.deletedTableName]?.columns ?? []
}

function findSoftDeleteColumn(
  table: Pick<ProjectedTable, 'columns'>,
  preferredName?: string
): ProjectionColumn | undefined {
  return (
    table.columns.find((col) =>
      preferredName
        ? col.name === preferredName
        : col.semanticTags.includes('soft_delete') || col.name === 'deleted'
    ) ??
    table.columns.find((col) => col.semanticTags.includes('soft_delete') || col.name === 'deleted')
  )
}

function sortColumnsByName(columns: ProjectionColumn[]): ProjectionColumn[] {
  return [...columns].sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Step 4: Filter relationships based on FK mode and visible tables
 *
 * FK mode logic:
 * - 'yes': Include relationship edges
 * - 'no': Exclude all relationship edges
 *
 * Also filters relationships to only include those between visible tables.
 * Low-confidence inferred edges stay hidden to match the "physically applied"
 * interpretation of the FK toggle.
 */
function filterRelationships(
  relationships: ProjectionRelationship[],
  visibleTables: Record<string, ProjectedTable>,
  config: ProjectionConfig,
  _metadata: ProjectionMetadata
): ProjectionRelationship[] {
  if (config.fkMode === 'no') {
    return []
  }

  return relationships.filter((rel) => {
    if (!visibleTables[rel.fromTable] || !visibleTables[rel.toTable]) {
      return false
    }

    if (rel.confidence === 'low') {
      return false
    }

    return true
  })
}

/**
 * Utility: Get all table names from the projected model
 */
export function getTableNames(model: ProjectedERDModel): string[] {
  return Object.keys(model.tables)
}

/**
 * Utility: Get table by name
 */
export function getTable(model: ProjectedERDModel, tableName: string): ProjectedTable | undefined {
  return model.tables[tableName]
}

/**
 * Utility: Get relationships for a specific table
 */
export function getTableRelationships(
  model: ProjectedERDModel,
  tableName: string
): ProjectionRelationship[] {
  return model.relationships.filter(
    (rel) => rel.fromTable === tableName || rel.toTable === tableName
  )
}

/**
 * Utility: Get outgoing relationships (from this table to others)
 */
export function getOutgoingRelationships(
  model: ProjectedERDModel,
  tableName: string
): ProjectionRelationship[] {
  return model.relationships.filter((rel) => rel.fromTable === tableName)
}

/**
 * Utility: Get incoming relationships (from other tables to this)
 */
export function getIncomingRelationships(
  model: ProjectedERDModel,
  tableName: string
): ProjectionRelationship[] {
  return model.relationships.filter((rel) => rel.toTable === tableName)
}

/**
 * Utility: Get virtual tables (synthesized by deleted mode)
 */
export function getVirtualTables(model: ProjectedERDModel): ProjectedTable[] {
  return Object.values(model.tables).filter((table) => table.isVirtual)
}

/**
 * Utility: Get non-virtual tables (from artifact)
 */
export function getNonVirtualTables(model: ProjectedERDModel): ProjectedTable[] {
  return Object.values(model.tables).filter((table) => !table.isVirtual)
}

/**
 * Utility: Check if a table is visible in the projected model
 */
export function isTableVisible(model: ProjectedERDModel, tableName: string): boolean {
  return tableName in model.tables
}
