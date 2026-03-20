import { describe, expect, it } from 'vitest'
import type {
  DeletedVariantMetadata,
  ProjectionArtifact,
  ProjectionConfig,
  ProjectionRelationship,
  ProjectionTable,
} from '@/types/projection'
import { DEFAULT_PROJECTION_CONFIG } from '@/types/projection'
import {
  deriveProjectedModel,
  getNonVirtualTables,
  getOutgoingRelationships,
  getIncomingRelationships,
  getTable,
  getTableNames,
  getTableRelationships,
  getVirtualTables,
} from '../projection-engine'

function createTable(
  overrides: Partial<ProjectionTable> &
    Pick<ProjectionTable, 'tableName' | 'namespace' | 'familyKey'>
): ProjectionTable {
  return {
    tableName: overrides.tableName,
    namespace: overrides.namespace,
    familyKey: overrides.familyKey,
    isCompatibilityOnly: false,
    isDeletedVariant: false,
    hasListEndpoint: false,
    hasWebhookEvent: false,
    columns: [],
    ...overrides,
  }
}

function createArtifact(): ProjectionArtifact {
  const relationships: ProjectionRelationship[] = [
    {
      fromTable: 'charges',
      fromColumn: 'customer',
      toTable: 'customers',
      toColumn: 'id',
      confidence: 'high',
    },
    {
      fromTable: 'payouts',
      fromColumn: 'destination',
      toTable: 'charges',
      toColumn: 'id',
      confidence: 'low',
    },
  ]

  const deletedVariants: DeletedVariantMetadata[] = [
    {
      liveTableName: 'charges',
      deletedTableName: 'deleted_charges',
      familyKey: 'charge',
      additionalColumns: ['deleted_at'],
      usesSoftDelete: true,
      softDeleteColumn: 'deleted',
      columns: [
        {
          name: 'id',
          semanticTags: ['primary_key'],
          logicalType: 'id',
          nullable: false,
        },
        {
          name: 'deleted',
          semanticTags: ['soft_delete'],
          logicalType: 'boolean',
          nullable: false,
        },
        {
          name: 'deleted_at',
          semanticTags: ['timestamp'],
          logicalType: 'timestamp',
          nullable: false,
        },
      ],
      namespace: 'v1',
      displayName: 'deleted_charges',
      hasListEndpoint: true,
      hasWebhookEvent: true,
    },
  ]

  return {
    apiVersion: '2026-02-24',
    generatedAt: '2026-03-17T00:00:00.000Z',
    capabilities: {
      hasV2Namespace: true,
      hasExplicitForeignKeys: false,
      hasDeletedVariants: true,
      hasListEndpointMetadata: true,
      hasWebhookEventMetadata: true,
      timestampFormat: 'mixed',
      tableCount: 4,
      relationshipCount: relationships.length,
    },
    tables: {
      charges: createTable({
        tableName: 'charges',
        namespace: 'v1',
        familyKey: 'charge',
        hasListEndpoint: true,
        hasWebhookEvent: true,
        columns: [
          {
            name: 'id',
            semanticTags: ['primary_key'],
            logicalType: 'id',
            nullable: false,
          },
          {
            name: 'created',
            semanticTags: ['timestamp'],
            logicalType: 'timestamp',
            nullable: false,
          },
          {
            name: 'deleted',
            semanticTags: ['soft_delete'],
            logicalType: 'boolean',
            nullable: false,
          },
        ],
      }),
      customers: createTable({
        tableName: 'customers',
        namespace: 'v2',
        familyKey: 'customer',
        hasListEndpoint: false,
        hasWebhookEvent: true,
        columns: [
          {
            name: 'id',
            semanticTags: ['primary_key'],
            logicalType: 'id',
            nullable: false,
          },
        ],
      }),
      payouts: createTable({
        tableName: 'payouts',
        namespace: 'v1',
        familyKey: 'payout',
        hasListEndpoint: true,
        hasWebhookEvent: false,
        columns: [
          {
            name: 'id',
            semanticTags: ['primary_key'],
            logicalType: 'id',
            nullable: false,
          },
        ],
      }),
    },
    relationships,
    deletedVariants,
  }
}

function createConfig(overrides: Partial<ProjectionConfig> = {}): ProjectionConfig {
  return {
    ...DEFAULT_PROJECTION_CONFIG,
    ...overrides,
  }
}

describe('projection-engine', () => {
  it('applies namespace and support filters together', () => {
    const model = deriveProjectedModel(createArtifact(), createConfig())

    expect(getTableNames(model)).toEqual(['charges'])
    expect(model.metadata.visibleTables).toBe(1)
  })

  it('can show unsupported resources when filters are flipped to no', () => {
    const model = deriveProjectedModel(
      createArtifact(),
      createConfig({
        listEndpointMode: 'no',
        webhookEventMode: 'no',
      })
    )

    expect(getTableNames(model)).toEqual([])
  })

  it('treats either support filters as unfiltered', () => {
    const model = deriveProjectedModel(
      createArtifact(),
      createConfig({
        listEndpointMode: 'either',
        webhookEventMode: 'either',
      })
    )

    expect(getTableNames(model)).toEqual(['charges', 'customers', 'payouts'])
  })

  it('applies list and webhook support filters independently with AND semantics', () => {
    const artifact = createArtifact()

    const listNoModel = deriveProjectedModel(
      artifact,
      createConfig({
        listEndpointMode: 'no',
        webhookEventMode: 'either',
      })
    )
    expect(getTableNames(listNoModel)).toEqual(['customers'])

    const webhookNoModel = deriveProjectedModel(
      artifact,
      createConfig({
        listEndpointMode: 'either',
        webhookEventMode: 'no',
      })
    )
    expect(getTableNames(webhookNoModel)).toEqual(['payouts'])

    const listYesWebhookEitherModel = deriveProjectedModel(
      artifact,
      createConfig({
        listEndpointMode: 'yes',
        webhookEventMode: 'either',
      })
    )
    expect(getTableNames(listYesWebhookEitherModel)).toEqual(['charges', 'payouts'])

    const listEitherWebhookYesModel = deriveProjectedModel(
      artifact,
      createConfig({
        listEndpointMode: 'either',
        webhookEventMode: 'yes',
      })
    )
    expect(getTableNames(listEitherWebhookYesModel)).toEqual(['charges', 'customers'])
  })

  it('ignores list/webhook filters when the artifact lacks metadata', () => {
    const artifact = createArtifact()
    artifact.capabilities.hasListEndpointMetadata = false
    artifact.capabilities.hasWebhookEventMetadata = false

    const model = deriveProjectedModel(artifact, createConfig())

    expect(getTableNames(model)).toEqual(['charges', 'customers', 'payouts'])
  })

  it('keeps only the selected namespace', () => {
    const model = deriveProjectedModel(
      createArtifact(),
      createConfig({
        namespaceMode: 'v2',
        listEndpointMode: 'no',
        webhookEventMode: 'yes',
      })
    )

    expect(getTableNames(model)).toEqual(['customers'])
  })

  it('promotes timestamp columns to timestamptz in timestamptz mode', () => {
    const model = deriveProjectedModel(
      createArtifact(),
      createConfig({
        timestampMode: 'timestamptz',
      })
    )

    const createdColumn = getTable(model, 'charges')?.columns.find(
      (column) => column.name === 'created'
    )
    expect(createdColumn?.logicalType).toBe('timestamptz')
    expect(model.metadata.timestampColumnsTransformed).toBe(1)
  })

  it('switches deleted resources between column and table modes', () => {
    const tableModeModel = deriveProjectedModel(
      createArtifact(),
      createConfig({
        deletedMode: 'table',
      })
    )

    expect(getTableNames(tableModeModel)).toEqual(['charges', 'deleted_charges'])
    expect(
      getTable(tableModeModel, 'charges')?.columns.some((column) => column.name === 'deleted')
    ).toBe(false)
    expect(getVirtualTables(tableModeModel).map((table) => table.tableName)).toEqual([
      'deleted_charges',
    ])
    expect(getNonVirtualTables(tableModeModel)).toHaveLength(1)

    const columnModeModel = deriveProjectedModel(createArtifact(), createConfig())
    expect(getTableNames(columnModeModel)).toEqual(['charges'])
    expect(
      getTable(columnModeModel, 'charges')?.columns.some((column) => column.name === 'deleted')
    ).toBe(true)
  })

  it('filters to v1 tables only when namespaceMode is v1', () => {
    const model = deriveProjectedModel(
      createArtifact(),
      createConfig({
        namespaceMode: 'v1',
        listEndpointMode: 'either',
        webhookEventMode: 'either',
      })
    )

    expect(getTableNames(model)).toEqual(['charges', 'payouts'])
    expect(model.tables.customers).toBeUndefined()
  })

  it('excludes non-v1/v2 namespace tables under all namespace modes', () => {
    const artifact = createArtifact()
    artifact.tables.utility_table = createTable({
      tableName: 'utility_table',
      namespace: 'utility',
      familyKey: 'utility',
      hasListEndpoint: true,
      hasWebhookEvent: true,
    })

    const bothModel = deriveProjectedModel(
      artifact,
      createConfig({ listEndpointMode: 'either', webhookEventMode: 'either' })
    )
    expect(getTableNames(bothModel)).not.toContain('utility_table')

    const v1Model = deriveProjectedModel(
      artifact,
      createConfig({ namespaceMode: 'v1', listEndpointMode: 'either', webhookEventMode: 'either' })
    )
    expect(getTableNames(v1Model)).not.toContain('utility_table')
  })

  it('does not affect the visible table set when toggling FK mode', () => {
    const artifact = createArtifact()
    artifact.capabilities.hasListEndpointMetadata = false
    artifact.capabilities.hasWebhookEventMetadata = false

    const fkEnabledModel = deriveProjectedModel(artifact, createConfig({ fkMode: 'yes' }))
    const fkDisabledModel = deriveProjectedModel(artifact, createConfig({ fkMode: 'no' }))

    expect(getTableNames(fkEnabledModel)).toEqual(getTableNames(fkDisabledModel))
    expect(fkEnabledModel.metadata.visibleTables).toBe(fkDisabledModel.metadata.visibleTables)
  })

  it('does not mutate original artifact columns when transforming timestamps', () => {
    const artifact = createArtifact()
    const originalColumn = artifact.tables.charges.columns.find((col) => col.name === 'created')
    expect(originalColumn?.logicalType).toBe('timestamp')

    deriveProjectedModel(artifact, createConfig({ timestampMode: 'timestamptz' }))

    const columnAfter = artifact.tables.charges.columns.find((col) => col.name === 'created')
    expect(columnAfter?.logicalType).toBe('timestamp')
  })

  it('injects soft-delete column from variant when live table lacks one', () => {
    const artifact = createArtifact()
    artifact.tables.invoices = createTable({
      tableName: 'invoices',
      namespace: 'v1',
      familyKey: 'invoice',
      hasListEndpoint: true,
      hasWebhookEvent: true,
      columns: [
        { name: 'id', semanticTags: ['primary_key'], logicalType: 'id', nullable: false },
        { name: 'amount', semanticTags: [], logicalType: 'number', nullable: false },
      ],
    })
    artifact.deletedVariants.push({
      liveTableName: 'invoices',
      deletedTableName: 'deleted_invoices',
      familyKey: 'invoice',
      additionalColumns: [],
      usesSoftDelete: true,
      softDeleteColumn: 'deleted',
      columns: [
        { name: 'id', semanticTags: ['primary_key'], logicalType: 'id', nullable: false },
        {
          name: 'deleted',
          semanticTags: ['soft_delete'],
          logicalType: 'boolean',
          nullable: false,
        },
      ],
      namespace: 'v1',
      displayName: 'deleted_invoices',
      hasListEndpoint: true,
      hasWebhookEvent: true,
    })

    const model = deriveProjectedModel(
      artifact,
      createConfig({ listEndpointMode: 'either', webhookEventMode: 'either' })
    )

    const invoicesTable = getTable(model, 'invoices')
    const injectedColumn = invoicesTable?.columns.find((col) => col.name === 'deleted')
    expect(injectedColumn).toBeDefined()
    expect(injectedColumn?.nullable).toBe(true)
    expect(injectedColumn?.generated).toBe(true)
  })

  it('tracks virtualTablesAdded and deletedFlagsRemoved counters in table mode', () => {
    const model = deriveProjectedModel(
      createArtifact(),
      createConfig({
        deletedMode: 'table',
        listEndpointMode: 'either',
        webhookEventMode: 'either',
      })
    )

    expect(model.metadata.virtualTablesAdded).toBe(1)
    expect(model.metadata.deletedFlagsRemoved).toBe(1)
    expect(model.metadata.totalTables).toBe(3)
    expect(model.metadata.totalRelationships).toBe(2)
    expect(model.metadata.visibleRelationships).toBe(0) // fkMode: 'no' by default
    expect(model.metadata.visibleTables).toBe(4) // charges, customers, payouts, deleted_charges
  })

  it('tracks visibleRelationships when FK mode is enabled', () => {
    const artifact = createArtifact()
    artifact.capabilities.hasListEndpointMetadata = false
    artifact.capabilities.hasWebhookEventMetadata = false

    const model = deriveProjectedModel(artifact, createConfig({ fkMode: 'yes' }))

    expect(model.metadata.totalRelationships).toBe(2)
    expect(model.metadata.visibleRelationships).toBe(1) // low-confidence edge excluded
  })

  it('returns outgoing and incoming relationships via utility functions', () => {
    const artifact = createArtifact()
    artifact.capabilities.hasListEndpointMetadata = false
    artifact.capabilities.hasWebhookEventMetadata = false

    const model = deriveProjectedModel(artifact, createConfig({ fkMode: 'yes' }))

    expect(getOutgoingRelationships(model, 'charges')).toHaveLength(1)
    expect(getIncomingRelationships(model, 'customers')).toHaveLength(1)
    expect(getOutgoingRelationships(model, 'customers')).toHaveLength(0)
    expect(getIncomingRelationships(model, 'charges')).toHaveLength(0) // low-confidence filtered
  })

  it('shows only non-low-confidence relationships when FK mode is enabled', () => {
    const artifact = createArtifact()
    artifact.capabilities.hasListEndpointMetadata = false
    artifact.capabilities.hasWebhookEventMetadata = false

    const enabledModel = deriveProjectedModel(
      artifact,
      createConfig({
        fkMode: 'yes',
      })
    )

    expect(enabledModel.relationships).toEqual([
      expect.objectContaining({
        fromTable: 'charges',
        toTable: 'customers',
        confidence: 'high',
      }),
    ])
    expect(getTableRelationships(enabledModel, 'charges')).toHaveLength(1)

    const disabledModel = deriveProjectedModel(
      artifact,
      createConfig({
        fkMode: 'no',
      })
    )
    expect(disabledModel.relationships).toEqual([])
  })
})
