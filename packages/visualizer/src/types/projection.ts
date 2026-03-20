/**
 * Projection Artifact Schema
 *
 * Defines the structure of projection.json artifacts that provide enhanced
 * metadata for ERD visualization, including provenance, semantic hints,
 * relationship candidates, and deleted-resource metadata.
 *
 * Location: /explorer-data/{apiVersion}/projection.json
 */

/**
 * Semantic tags for columns that hint at their logical purpose
 * Used to identify special columns without parsing OpenAPI schemas client-side
 */
export type SemanticTag =
  | 'primary_key' // Primary identifier (e.g., id)
  | 'foreign_key' // Reference to another table
  | 'expandable_ref' // Stripe expandable reference field
  | 'timestamp' // Temporal data
  | 'soft_delete' // Soft delete indicator (e.g., deleted column)
  | 'resource_type' // Discriminator for polymorphic relationships
  | 'metadata' // Flexible metadata field
  | 'array' // Array/list type
  | 'object' // Complex object type

/**
 * Logical data types that abstract over SQL types
 * Provides semantic meaning beyond raw SQL column types
 */
export type LogicalType =
  | 'id' // Unique identifier
  | 'string' // Text data
  | 'number' // Numeric data
  | 'boolean' // Boolean flag
  | 'timestamp' // Unix timestamp (integer)
  | 'timestamptz' // Timestamp with timezone
  | 'json' // JSON data
  | 'array' // Array/list
  | 'enum' // Enumerated type
  | 'unknown' // Type could not be determined

/**
 * Column metadata with semantic annotations
 */
export interface ProjectionColumn {
  /**
   * Column name in the PostgreSQL table
   */
  name: string

  /**
   * Semantic tags that describe the column's purpose
   * Multiple tags may apply (e.g., ['foreign_key', 'expandable_ref'])
   */
  semanticTags: SemanticTag[]

  /**
   * Logical data type abstracted from SQL type
   */
  logicalType: LogicalType

  /**
   * Original SQL-ish type emitted by sync-engine.
   * Used when the UI wants to show the raw materialized shape instead of
   * the projection-friendly logical type.
   */
  materializedType?: string

  /**
   * For foreign_key columns: the target table name
   * Enables FK relationship reconstruction without re-parsing schemas
   */
  referencesTable?: string

  /**
   * For foreign_key columns: the target column name (typically 'id')
   */
  referencesColumn?: string

  /**
   * Source Stripe resource ids that this column can reference.
   * Populated for explicit expandable-reference metadata from OpenAPI.
   */
  referenceResourceIds?: string[]

  /**
   * For expandable_ref columns: the resource family key
   * Used to resolve polymorphic references (e.g., 'charge' -> 'charges' table)
   */
  resourceFamilyKey?: string

  /**
   * Whether this column is nullable
   */
  nullable: boolean

  /**
   * Whether this is a generated column (e.g., from _raw_data JSONB)
   */
  generated?: boolean
}

/**
 * API namespace classification
 * Distinguishes resources sourced from Stripe's /v1 and /v2 endpoint families.
 */
export type NamespaceTag =
  | 'v1' // Resources sourced from Stripe /v1 endpoints or legacy schemas
  | 'v2' // Resources sourced from Stripe /v2 endpoints / v2.* schemas
  | 'compatibility' // Compatibility shim tables
  | 'utility' // System/metadata tables (e.g., migration_meta)
  | 'unclassified' // Ambiguous or hybrid resources

/**
 * Table metadata with provenance and classification
 */
export interface ProjectionTable {
  /**
   * Table name in the PostgreSQL schema (e.g., 'charges', 'charges_deleted')
   */
  tableName: string

  /**
   * Human-facing label for ERD rendering.
   * Keeps the physical table key stable while allowing friendlier naming.
   */
  displayName?: string

  /**
   * API namespace classification (/v1 vs /v2 provenance)
   */
  namespace: NamespaceTag

  /**
   * Stripe API resource family key (e.g., 'charge', 'customer')
   * Used to link related tables (e.g., charges -> charges_deleted)
   * and resolve expandable references
   */
  familyKey: string

  /**
   * Whether this is a compatibility-only table
   * (e.g., legacy_events for v1 backwards compatibility)
   */
  isCompatibilityOnly: boolean

  /**
   * Whether this is a deleted-resource variant table
   * (e.g., charges_deleted, customers_deleted)
   */
  isDeletedVariant: boolean

  /**
   * All OpenAPI resource ids that were merged into this table.
   * Useful for namespace/debugging and deleted-resource pairing.
   */
  resourceIds?: string[]

  /**
   * Primary schema name retained from sync-engine parsing.
   * Useful as a secondary namespace hint and for debugging artifact output.
   */
  sourceSchemaName?: string

  /**
   * All source schema names merged into this table.
   */
  sourceSchemaNames?: string[]

  /**
   * Collection paths that caused this resource to be projected into a table.
   * Path prefixes are the primary /v1 vs /v2 classification signal.
   */
  sourcePaths?: string[]

  /**
   * True when at least one backing resource has exactly one canonical /v1 or /v2 list path.
   * Mirrors the OpenAPI supportsBackfill heuristic exposed in the UI as "hasListEndpoint".
   */
  hasListEndpoint: boolean

  /**
   * True when at least one backing resource can be targeted by a mapped webhook event.
   * Mirrors the OpenAPI supportsRealtime heuristic exposed in the UI as "hasWebhookEvent".
   */
  hasWebhookEvent: boolean

  /**
   * Column definitions with semantic annotations
   */
  columns: ProjectionColumn[]

  /**
   * For deleted-variant tables: the primary live table name
   * Enables linking between live and deleted variants
   */
  liveTableName?: string

  /**
   * Number of rows in this table (from manifest)
   */
  rowCount?: number
}

/**
 * Confidence level for relationship detection
 * Based on heuristic analysis of column names and types
 */
export type RelationshipConfidence =
  | 'high' // Explicit FK constraint or clear naming pattern
  | 'medium' // Likely FK based on naming but no constraint
  | 'low' // Possible FK but ambiguous

/**
 * Foreign key relationship candidate
 * Surfaced from sync-engine parser analysis
 */
export interface ProjectionRelationship {
  /**
   * Source table containing the foreign key
   */
  fromTable: string

  /**
   * Source column name (e.g., 'customer_id', 'customer')
   */
  fromColumn: string

  /**
   * Target table being referenced
   */
  toTable: string

  /**
   * Target column name (typically 'id')
   */
  toColumn: string

  /**
   * Confidence level of this relationship
   * Used to filter low-confidence edges in the ERD
   */
  confidence: RelationshipConfidence

  /**
   * Whether this relationship is polymorphic
   * (e.g., source.id can reference multiple target tables)
   */
  isPolymorphic?: boolean

  /**
   * For polymorphic relationships: the discriminator column
   * (e.g., 'object' field that specifies the target type)
   */
  discriminatorColumn?: string
}

/**
 * Deleted-resource variant metadata
 * Links live tables to their deleted counterparts
 */
export interface DeletedVariantMetadata {
  /**
   * The primary live table name (e.g., 'charges')
   */
  liveTableName: string

  /**
   * The deleted-variant table name (e.g., 'charges_deleted')
   */
  deletedTableName: string

  /**
   * Resource family key linking them (e.g., 'charge')
   */
  familyKey: string

  /**
   * Columns present in deleted variant but not in live table
   * (e.g., 'deleted_at', 'deletion_reason')
   */
  additionalColumns: string[]

  /**
   * Whether column mode can inline a deleted marker onto the live table
   * for this family.
   */
  usesSoftDelete: boolean

  /**
   * Name of the deleted marker column to inline/remove when switching
   * between column and table modes (e.g., 'deleted').
   */
  softDeleteColumn?: string

  /**
   * Projection-ready column definitions for the deleted-resource shape.
   * When present, the ERD can synthesize a virtual deleted table without
   * requiring that table to exist in the hydrated PGlite schema.
   */
  columns?: ProjectionColumn[]

  /**
   * Namespace provenance for the deleted-resource variant.
   * Falls back to the live table namespace when omitted.
   */
  namespace?: NamespaceTag

  /**
   * Optional ERD display name for the deleted-resource variant.
   */
  displayName?: string

  /**
   * Support heuristics mirrored from the deleted-resource schema when available.
   * Falls back to the live table support flags when omitted.
   */
  hasListEndpoint?: boolean
  hasWebhookEvent?: boolean
}

/**
 * Version capability flags
 * Indicates what features are available in this API version
 */
export interface VersionCapabilities {
  /**
   * Whether this artifact includes any /v2 namespace tables
   */
  hasV2Namespace: boolean

  /**
   * Whether explicit FK constraints are present
   * (vs. relying on relationship candidates)
   */
  hasExplicitForeignKeys: boolean

  /**
   * Whether deleted-resource tables exist
   */
  hasDeletedVariants: boolean

  /**
   * Whether x-stripeOperations metadata exists for these resources.
   * When false, list-endpoint filters should be treated as unavailable.
   */
  hasListEndpointMetadata: boolean

  /**
   * Whether x-stripeEvent metadata exists for these resources.
   * When false, webhook-event filters should be treated as unavailable.
   */
  hasWebhookEventMetadata: boolean

  /**
   * Whether timestamps are raw (integer) or timestamptz
   */
  timestampFormat: 'raw' | 'timestamptz' | 'mixed'

  /**
   * Number of tables in this version
   */
  tableCount: number

  /**
   * Number of relationship candidates identified
   */
  relationshipCount: number
}

/**
 * The projection artifact structure
 * Generated at build time by the projection generator
 */
export interface ProjectionArtifact {
  /**
   * Stripe API version this artifact was generated for
   */
  apiVersion: string

  /**
   * ISO 8601 timestamp of when this artifact was generated
   */
  generatedAt: string

  /**
   * Capability flags for this API version
   */
  capabilities: VersionCapabilities

  /**
   * Table metadata with provenance and semantic annotations
   * Keyed by table name for O(1) lookup
   */
  tables: Record<string, ProjectionTable>

  /**
   * Relationship candidates detected from schema analysis
   * Pre-computed to avoid client-side FK detection
   */
  relationships: ProjectionRelationship[]

  /**
   * Deleted-resource variant mappings
   * Links live tables to their deleted counterparts
   */
  deletedVariants: DeletedVariantMetadata[]
}

/**
 * Projection Config State Model
 * User-controllable filters for ERD projection modes
 */

/**
 * Namespace filter mode
 * Controls which tables are included based on Stripe namespace provenance,
 * not the selected API version date.
 */
export type NamespaceMode =
  | 'v1' // Only /v1 namespace tables
  | 'v2' // Only /v2 namespace tables
  | 'both' // Union of /v1 and /v2 tables

export type ListEndpointMode =
  | 'either' // Do not filter by list-endpoint support
  | 'yes' // Only resources with a canonical list endpoint
  | 'no' // Only resources without a canonical list endpoint

export type WebhookEventMode =
  | 'either' // Do not filter by webhook-event support
  | 'yes' // Only resources with mapped webhook events
  | 'no' // Only resources without mapped webhook events

/**
 * Foreign key display mode
 * Controls whether FK relationships are rendered
 */
export type ForeignKeyMode =
  | 'no' // Hide all FK edges
  | 'yes' // Show FK edges

/**
 * Timestamp display mode
 * Controls whether timestamps are shown as raw integers or formatted
 */
export type TimestampMode =
  | 'raw' // Show as Unix timestamp (integer)
  | 'timestamptz' // Show as timestamp with timezone

/**
 * Deleted-resource display mode
 * Controls how deleted variants are shown
 */
export type DeletedMode =
  | 'column' // Show as soft-delete column in main table
  | 'table' // Show as separate deleted-variant table

/**
 * Projection configuration state
 * Controls ERD filtering and display options
 */
export interface ProjectionConfig {
  /**
   * Namespace filter mode
   * Default: 'both'
   */
  namespaceMode: NamespaceMode

  /**
   * Filter tables by the canonical list-endpoint heuristic.
   * Default: 'yes'
   */
  listEndpointMode: ListEndpointMode

  /**
   * Filter tables by the mapped webhook-event heuristic.
   * Default: 'yes'
   */
  webhookEventMode: WebhookEventMode

  /**
   * Foreign key display mode
   * Default: 'no'
   */
  fkMode: ForeignKeyMode

  /**
   * Timestamp display mode
   * Default: 'raw' (preserves original format)
   */
  timestampMode: TimestampMode

  /**
   * Deleted-resource display mode
   * Default: 'column' (soft-delete column in main table)
   */
  deletedMode: DeletedMode
}

/**
 * Default projection configuration
 * Used when no user preferences are stored
 */
export const DEFAULT_PROJECTION_CONFIG: ProjectionConfig = {
  namespaceMode: 'both',
  listEndpointMode: 'yes',
  webhookEventMode: 'yes',
  fkMode: 'no',
  timestampMode: 'raw',
  deletedMode: 'column',
}

/**
 * Example projection artifact structure:
 *
 * ```json
 * {
 *   "apiVersion": "v1",
 *   "generatedAt": "2026-03-13T12:00:00Z",
 *   "capabilities": {
 *     "hasV2Namespace": true,
 *     "hasExplicitForeignKeys": false,
 *     "hasDeletedVariants": true,
 *     "timestampFormat": "raw",
 *     "tableCount": 120,
 *     "relationshipCount": 85
 *   },
 *   "tables": {
 *     "charges": {
 *       "tableName": "charges",
 *       "namespace": "v1",
 *       "familyKey": "charge",
 *       "isCompatibilityOnly": false,
 *       "isDeletedVariant": false,
 *       "columns": [
 *         {
 *           "name": "id",
 *           "semanticTags": ["primary_key"],
 *           "logicalType": "id",
 *           "nullable": false
 *         },
 *         {
 *           "name": "customer",
 *           "semanticTags": ["foreign_key", "expandable_ref"],
 *           "logicalType": "string",
 *           "referencesTable": "customers",
 *           "referencesColumn": "id",
 *           "resourceFamilyKey": "customer",
 *           "nullable": true
 *         }
 *       ],
 *       "rowCount": 1500
 *     }
 *   },
 *   "relationships": [
 *     {
 *       "fromTable": "charges",
 *       "fromColumn": "customer",
 *       "toTable": "customers",
 *       "toColumn": "id",
 *       "confidence": "high"
 *     }
 *   ],
 *   "deletedVariants": [
 *     {
 *       "liveTableName": "charges",
 *       "deletedTableName": "charges_deleted",
 *       "familyKey": "charge",
 *       "additionalColumns": ["deleted_at"],
 *       "usesSoftDelete": false
 *     }
 *   ]
 * }
 * ```
 */
