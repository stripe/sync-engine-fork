import { describe, expect, it } from 'vitest'
import type { ParsedResourceTable } from '../../../sync-engine/src/openapi/types'
import type { ResourceSupportProfile } from '../../../sync-engine/src/openapi/resourceSupport'
import { DEFAULT_PROJECTION_CONFIG } from '../../src/types/projection'
import { deriveProjectedModel } from '../../src/lib/projection-engine'
import { buildProjectionArtifactFromParsedTables } from '../generate-projection'

function createProfile(
  resourceId: string,
  overrides: Partial<ResourceSupportProfile> = {}
): ResourceSupportProfile {
  return {
    resourceId,
    hasObjectSchema: true,
    hasStripeOperations: false,
    listOperationCount: 0,
    listPathCount: 0,
    webhookEventTypes: [],
    hasListEndpoint: false,
    hasWebhookEvent: false,
    supportsBackfill: false,
    supportsRealtime: false,
    isDeployable: false,
    ...overrides,
  }
}

function createParsedTable(
  overrides: Partial<ParsedResourceTable> &
    Pick<ParsedResourceTable, 'tableName' | 'resourceId'>
): ParsedResourceTable {
  return {
    tableName: overrides.tableName,
    resourceId: overrides.resourceId,
    sourceSchemaName: 'default',
    columns: [],
    ...overrides,
  }
}

describe('generate-projection contract', () => {
  it('builds artifacts with support capability flags and stable apiVersion passthrough', () => {
    const parsedTables: ParsedResourceTable[] = [
      createParsedTable({
        tableName: 'charges',
        resourceId: 'charge',
        resourceIds: ['charge'],
        sourceSchemaName: 'charge',
        sourcePaths: ['/v1/charges'],
        columns: [
          { name: 'id', type: 'text', nullable: false },
          {
            name: 'customer',
            type: 'text',
            nullable: true,
            expandableReference: true,
            referenceResourceIds: ['customer'],
          },
        ],
      }),
      createParsedTable({
        tableName: 'customers',
        resourceId: 'customer',
        resourceIds: ['customer'],
        sourceSchemaName: 'customer',
        sourcePaths: ['/v1/customers'],
        columns: [{ name: 'id', type: 'text', nullable: false }],
      }),
      createParsedTable({
        tableName: 'v2_customers',
        resourceId: 'v2.core.customer',
        resourceIds: ['v2.core.customer'],
        sourceSchemaName: 'v2.core.customer',
        sourcePaths: ['/v2/core/customers'],
        columns: [{ name: 'id', type: 'text', nullable: false }],
      }),
    ]

    const profiles = new Map<string, ResourceSupportProfile>([
      [
        'charge',
        createProfile('charge', {
          hasStripeOperations: true,
          listOperationCount: 1,
          listPathCount: 1,
          canonicalListPath: '/v1/charges',
          webhookEventTypes: ['charge.succeeded'],
          hasListEndpoint: true,
          hasWebhookEvent: true,
          supportsBackfill: true,
          supportsRealtime: true,
          isDeployable: true,
        }),
      ],
      ['customer', createProfile('customer')],
      [
        'v2.core.customer',
        createProfile('v2.core.customer', {
          hasStripeOperations: true,
          listOperationCount: 1,
          listPathCount: 1,
          canonicalListPath: '/v2/core/customers',
          hasListEndpoint: true,
          supportsBackfill: true,
        }),
      ],
    ])

    const artifact = buildProjectionArtifactFromParsedTables({
      apiVersion: '2022-08-01',
      parsedTables,
      resourceSupportProfiles: profiles,
      generatedAt: '2026-03-19T00:00:00.000Z',
    })

    expect(artifact.apiVersion).toBe('2022-08-01')
    expect(artifact.capabilities.hasV2Namespace).toBe(true)
    expect(artifact.capabilities.hasListEndpointMetadata).toBe(true)
    expect(artifact.capabilities.hasWebhookEventMetadata).toBe(true)
    expect(artifact.tables.charges.hasListEndpoint).toBe(true)
    expect(artifact.tables.charges.hasWebhookEvent).toBe(true)
    expect(artifact.tables.customers.hasListEndpoint).toBe(false)
    expect(artifact.tables.customers.hasWebhookEvent).toBe(false)
    expect(artifact.relationships).toEqual([
      expect.objectContaining({
        fromTable: 'charges',
        fromColumn: 'customer',
        toTable: 'customers',
        confidence: 'high',
      }),
    ])
  })

  it('keeps default projection filtering disabled when generated metadata is unavailable', () => {
    const parsedTables: ParsedResourceTable[] = [
      createParsedTable({
        tableName: 'legacy_resource',
        resourceId: 'legacy_resource',
        sourceSchemaName: 'legacy_resource',
        sourcePaths: ['/v1/legacy_resources'],
        columns: [{ name: 'id', type: 'text', nullable: false }],
      }),
    ]

    const profiles = new Map<string, ResourceSupportProfile>([
      ['legacy_resource', createProfile('legacy_resource')],
    ])

    const artifact = buildProjectionArtifactFromParsedTables({
      apiVersion: '2020-08-27',
      parsedTables,
      resourceSupportProfiles: profiles,
      generatedAt: '2026-03-19T00:00:00.000Z',
    })

    expect(artifact.capabilities.hasListEndpointMetadata).toBe(false)
    expect(artifact.capabilities.hasWebhookEventMetadata).toBe(false)

    const model = deriveProjectedModel(artifact, DEFAULT_PROJECTION_CONFIG)
    expect(model.metadata.visibleTables).toBe(1)
    expect(model.tables.legacy_resource).toBeDefined()
  })

  it('builds deleted-resource mappings that drive column and table projection modes', () => {
    const parsedTables: ParsedResourceTable[] = [
      createParsedTable({
        tableName: 'customers',
        resourceId: 'customer',
        resourceIds: ['customer'],
        sourceSchemaName: 'customer',
        sourcePaths: ['/v1/customers'],
        columns: [
          { name: 'id', type: 'text', nullable: false },
          { name: 'deleted', type: 'boolean', nullable: true },
        ],
      }),
    ]

    const deletedParsedTables: ParsedResourceTable[] = [
      createParsedTable({
        tableName: 'deleted_customers',
        resourceId: 'deleted_customer',
        resourceIds: ['deleted_customer'],
        sourceSchemaName: 'deleted_customer',
        sourcePaths: ['/v1/customers/{customer}'],
        columns: [
          { name: 'id', type: 'text', nullable: false },
          { name: 'deleted', type: 'boolean', nullable: false },
        ],
      }),
    ]

    const profiles = new Map<string, ResourceSupportProfile>([
      [
        'customer',
        createProfile('customer', {
          hasStripeOperations: true,
          listOperationCount: 1,
          listPathCount: 1,
          canonicalListPath: '/v1/customers',
          webhookEventTypes: ['customer.updated'],
          hasListEndpoint: true,
          hasWebhookEvent: true,
          supportsBackfill: true,
          supportsRealtime: true,
          isDeployable: true,
        }),
      ],
      [
        'deleted_customer',
        createProfile('deleted_customer', {
          webhookEventTypes: ['customer.updated'],
          hasWebhookEvent: true,
          supportsRealtime: true,
        }),
      ],
    ])

    const artifact = buildProjectionArtifactFromParsedTables({
      apiVersion: '2020-08-27',
      parsedTables,
      deletedParsedTables,
      resourceSupportProfiles: profiles,
      generatedAt: '2026-03-19T00:00:00.000Z',
    })

    expect(artifact.capabilities.hasListEndpointMetadata).toBe(true)
    expect(artifact.capabilities.hasWebhookEventMetadata).toBe(true)
    expect(artifact.tables.customers).toBeDefined()
    expect(artifact.tables.deleted_customers).toBeUndefined()
    expect(artifact.tables.customers.hasListEndpoint).toBe(true)
    expect(artifact.tables.customers.hasWebhookEvent).toBe(true)
    expect(artifact.deletedVariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          liveTableName: 'customers',
          deletedTableName: 'deleted_customers',
          familyKey: 'customer',
          hasWebhookEvent: true,
          columns: expect.arrayContaining([expect.objectContaining({ name: 'deleted' })]),
        }),
      ])
    )

    const defaultModel = deriveProjectedModel(artifact, DEFAULT_PROJECTION_CONFIG)
    expect(defaultModel.tables.deleted_customers).toBeUndefined()
    expect(defaultModel.tables.customers.columns.some((column) => column.name === 'deleted')).toBe(
      true
    )

    const deletedTableModel = deriveProjectedModel(artifact, {
      ...DEFAULT_PROJECTION_CONFIG,
      deletedMode: 'table',
    })
    expect(deletedTableModel.tables.deleted_customers).toBeDefined()
    expect(deletedTableModel.tables.deleted_customers.isVirtual).toBe(true)
    expect(
      deletedTableModel.tables.customers.columns.some((column) => column.name === 'deleted')
    ).toBe(false)
  })
})
