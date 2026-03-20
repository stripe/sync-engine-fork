import { describe, expect, it } from 'vitest'
import type {
  DeletedMode,
  DeletedVariantMetadata,
  ForeignKeyMode,
  ListEndpointMode,
  LogicalType,
  NamespaceMode,
  NamespaceTag,
  ProjectionArtifact,
  ProjectionColumn,
  ProjectionConfig,
  ProjectionRelationship,
  ProjectionTable,
  RelationshipConfidence,
  SemanticTag,
  TimestampMode,
  VersionCapabilities,
  WebhookEventMode,
} from '../projection'
import { DEFAULT_PROJECTION_CONFIG } from '../projection'

const testColumn: ProjectionColumn = {
  name: 'id',
  semanticTags: ['primary_key'],
  logicalType: 'id',
  nullable: false,
}

const testTable: ProjectionTable = {
  tableName: 'charges',
  namespace: 'v1',
  familyKey: 'charge',
  isCompatibilityOnly: false,
  isDeletedVariant: false,
  hasListEndpoint: true,
  hasWebhookEvent: true,
  columns: [testColumn],
}

const testRelationship: ProjectionRelationship = {
  fromTable: 'charges',
  fromColumn: 'customer',
  toTable: 'customers',
  toColumn: 'id',
  confidence: 'high',
}

const testDeletedVariant: DeletedVariantMetadata = {
  liveTableName: 'charges',
  deletedTableName: 'charges_deleted',
  familyKey: 'charge',
  additionalColumns: ['deleted_at'],
  usesSoftDelete: false,
}

const testCapabilities: VersionCapabilities = {
  hasV2Namespace: true,
  hasExplicitForeignKeys: false,
  hasDeletedVariants: true,
  hasListEndpointMetadata: true,
  hasWebhookEventMetadata: true,
  timestampFormat: 'mixed',
  tableCount: 1,
  relationshipCount: 1,
}

const testArtifact: ProjectionArtifact = {
  apiVersion: '2026-02-24',
  generatedAt: '2026-03-17T00:00:00.000Z',
  capabilities: testCapabilities,
  tables: {
    charges: testTable,
  },
  relationships: [testRelationship],
  deletedVariants: [testDeletedVariant],
}

describe('projection types', () => {
  it('accepts the projection artifact shape with support heuristics', () => {
    expect(testArtifact.tables.charges.hasListEndpoint).toBe(true)
    expect(testArtifact.tables.charges.hasWebhookEvent).toBe(true)
    expect(testArtifact.capabilities.hasListEndpointMetadata).toBe(true)
    expect(testArtifact.capabilities.hasWebhookEventMetadata).toBe(true)
  })

  it('accepts projection config with the trimmed control surface', () => {
    const config: ProjectionConfig = {
      namespaceMode: 'both',
      listEndpointMode: 'either',
      webhookEventMode: 'no',
      fkMode: 'yes',
      timestampMode: 'timestamptz',
      deletedMode: 'table',
    }

    expect(config).toEqual({
      namespaceMode: 'both',
      listEndpointMode: 'either',
      webhookEventMode: 'no',
      fkMode: 'yes',
      timestampMode: 'timestamptz',
      deletedMode: 'table',
    })
  })

  it('keeps deployable defaults focused on listable + webhook-backed resources', () => {
    expect(DEFAULT_PROJECTION_CONFIG).toEqual({
      namespaceMode: 'both',
      listEndpointMode: 'yes',
      webhookEventMode: 'yes',
      fkMode: 'no',
      timestampMode: 'raw',
      deletedMode: 'column',
    })
  })

  it('keeps the literal unions aligned with the UI controls', () => {
    const namespaceModes: NamespaceMode[] = ['v1', 'v2', 'both']
    const listModes: ListEndpointMode[] = ['either', 'yes', 'no']
    const webhookModes: WebhookEventMode[] = ['either', 'yes', 'no']
    const fkModes: ForeignKeyMode[] = ['yes', 'no']
    const timestampModes: TimestampMode[] = ['raw', 'timestamptz']
    const deletedModes: DeletedMode[] = ['column', 'table']
    const relationshipConfidences: RelationshipConfidence[] = ['high', 'medium', 'low']
    const namespaceTags: NamespaceTag[] = ['v1', 'v2', 'compatibility', 'utility', 'unclassified']
    const semanticTags: SemanticTag[] = [
      'primary_key',
      'foreign_key',
      'expandable_ref',
      'timestamp',
      'soft_delete',
      'resource_type',
      'metadata',
      'array',
      'object',
    ]
    const logicalTypes: LogicalType[] = [
      'id',
      'string',
      'number',
      'boolean',
      'timestamp',
      'timestamptz',
      'json',
      'array',
      'enum',
      'unknown',
    ]

    expect(namespaceModes).toHaveLength(3)
    expect(listModes).toEqual(['either', 'yes', 'no'])
    expect(webhookModes).toEqual(['either', 'yes', 'no'])
    expect(fkModes).toEqual(['yes', 'no'])
    expect(timestampModes).toEqual(['raw', 'timestamptz'])
    expect(deletedModes).toEqual(['column', 'table'])
    expect(relationshipConfidences).toEqual(['high', 'medium', 'low'])
    expect(namespaceTags).toContain('utility')
    expect(semanticTags).toContain('expandable_ref')
    expect(logicalTypes).toContain('timestamptz')
  })
})
