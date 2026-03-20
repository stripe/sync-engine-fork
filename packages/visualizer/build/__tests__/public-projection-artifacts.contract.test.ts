import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECTION_CONFIG } from '../../src/types/projection'
import { deriveProjectedModel } from '../../src/lib/projection-engine'
import type { ProjectionArtifact } from '../../src/types/projection'
import type { VersionIndex } from '../../src/types/version-index'

type ManifestData = {
  totalTables: number
}

const explorerDataDir = path.join(__dirname, '../../public/explorer-data')
const versionIndex = JSON.parse(
  fs.readFileSync(path.join(explorerDataDir, 'index.json'), 'utf8')
) as VersionIndex

function readProjectionArtifact(apiVersion: string): ProjectionArtifact {
  return JSON.parse(
    fs.readFileSync(path.join(explorerDataDir, apiVersion, 'projection.json'), 'utf8')
  ) as ProjectionArtifact
}

function readManifest(apiVersion: string): ManifestData {
  return JSON.parse(
    fs.readFileSync(path.join(explorerDataDir, apiVersion, 'manifest.json'), 'utf8')
  ) as ManifestData
}

function getVisibleV2TableNames(
  artifact: ProjectionArtifact,
  overrides: Partial<typeof DEFAULT_PROJECTION_CONFIG> = {}
): string[] {
  return Object.keys(
    deriveProjectedModel(artifact, {
      ...DEFAULT_PROJECTION_CONFIG,
      ...overrides,
    }).tables
  )
    .filter((tableName) => tableName.startsWith('v2_'))
    .sort()
}

describe('checked-in projection artifacts', () => {
  it('stay aligned with the versioned PGlite schema inventory and expose current metadata flags', () => {
    for (const version of versionIndex.versions) {
      const artifact = readProjectionArtifact(version.apiVersion)
      const manifest = readManifest(version.apiVersion)

      expect(artifact.apiVersion).toBe(version.apiVersion)
      expect(Object.keys(artifact.tables)).toHaveLength(manifest.totalTables)
      expect(artifact.capabilities.tableCount).toBe(manifest.totalTables)
      expect(typeof artifact.capabilities.hasListEndpointMetadata).toBe('boolean')
      expect(typeof artifact.capabilities.hasWebhookEventMetadata).toBe('boolean')
      expect(typeof artifact.capabilities.hasDeletedVariants).toBe('boolean')

      for (const table of Object.values(artifact.tables)) {
        expect(typeof table.hasListEndpoint).toBe('boolean')
        expect(typeof table.hasWebhookEvent).toBe('boolean')
      }
    }
  })

  it('link deleted-resource variants without self-referential placeholders', () => {
    for (const version of versionIndex.versions) {
      const artifact = readProjectionArtifact(version.apiVersion)

      for (const deletedVariant of artifact.deletedVariants) {
        expect(deletedVariant.liveTableName).not.toBe(deletedVariant.deletedTableName)
        expect(artifact.tables[deletedVariant.liveTableName]).toBeDefined()
        expect(
          (deletedVariant.columns?.length ?? 0) > 0 ||
            artifact.tables[deletedVariant.deletedTableName] !== undefined
        ).toBe(true)
      }
    }
  })

  it('lets the shipped default artifact switch deleted resources between column and table modes', () => {
    const artifact = readProjectionArtifact(versionIndex.defaultVersion)

    expect(artifact.tables.customers).toBeDefined()
    expect(artifact.tables.deleted_customers).toBeUndefined()

    const columnModeModel = deriveProjectedModel(artifact, DEFAULT_PROJECTION_CONFIG)
    expect(columnModeModel.tables.deleted_customers).toBeUndefined()
    expect(columnModeModel.tables.customers.columns.some((column) => column.name === 'deleted')).toBe(
      true
    )

    const tableModeModel = deriveProjectedModel(artifact, {
      ...DEFAULT_PROJECTION_CONFIG,
      deletedMode: 'table',
    })
    expect(tableModeModel.tables.deleted_customers).toBeDefined()
    expect(tableModeModel.tables.deleted_customers.isVirtual).toBe(true)
    expect(
      tableModeModel.tables.customers.columns.some((column) => column.name === 'deleted')
    ).toBe(false)
  })

  it('pins the shipped v2 namespace rollout boundary between 2025-01-27 and 2026-02-24', () => {
    const legacyArtifact = readProjectionArtifact('2025-01-27')
    const unifiedArtifact = readProjectionArtifact('2026-02-24')
    const unifiedV2Tables = Object.keys(unifiedArtifact.tables)
      .filter((tableName) => tableName.startsWith('v2_'))
      .sort()

    expect(legacyArtifact.capabilities.hasV2Namespace).toBe(false)
    expect(Object.keys(legacyArtifact.tables).some((tableName) => tableName.startsWith('v2_'))).toBe(
      false
    )

    expect(unifiedArtifact.capabilities.hasV2Namespace).toBe(true)
    expect(unifiedV2Tables).toEqual([
      'v2_core_account_person_tokens',
      'v2_core_account_persons',
      'v2_core_account_tokens',
      'v2_core_accounts',
      'v2_core_event_destinations',
      'v2_core_events',
    ])
    expect(unifiedArtifact.tables.v2_core_account_links).toBeUndefined()
    expect(unifiedArtifact.tables.ephemeral_keys).toBeUndefined()
  })

  it('applies the shipped list/webhook filter matrix consistently to the real 2026-02-24 v2 tables', () => {
    const artifact = readProjectionArtifact('2026-02-24')

    expect(getVisibleV2TableNames(artifact)).toEqual([
      'v2_core_account_persons',
      'v2_core_accounts',
      'v2_core_event_destinations',
    ])

    expect(
      getVisibleV2TableNames(artifact, {
        namespaceMode: 'v2',
        listEndpointMode: 'either',
        webhookEventMode: 'either',
      })
    ).toEqual([
      'v2_core_account_person_tokens',
      'v2_core_account_persons',
      'v2_core_account_tokens',
      'v2_core_accounts',
      'v2_core_event_destinations',
      'v2_core_events',
    ])

    expect(
      getVisibleV2TableNames(artifact, {
        namespaceMode: 'v2',
        listEndpointMode: 'yes',
        webhookEventMode: 'either',
      })
    ).toEqual([
      'v2_core_account_persons',
      'v2_core_accounts',
      'v2_core_event_destinations',
      'v2_core_events',
    ])

    expect(
      getVisibleV2TableNames(artifact, {
        namespaceMode: 'v2',
        listEndpointMode: 'either',
        webhookEventMode: 'yes',
      })
    ).toEqual([
      'v2_core_account_persons',
      'v2_core_accounts',
      'v2_core_event_destinations',
    ])

    expect(
      getVisibleV2TableNames(artifact, {
        namespaceMode: 'v2',
        listEndpointMode: 'no',
        webhookEventMode: 'either',
      })
    ).toEqual(['v2_core_account_person_tokens', 'v2_core_account_tokens'])

    expect(
      getVisibleV2TableNames(artifact, {
        namespaceMode: 'v2',
        listEndpointMode: 'either',
        webhookEventMode: 'no',
      })
    ).toEqual([
      'v2_core_account_person_tokens',
      'v2_core_account_tokens',
      'v2_core_events',
    ])
  })
})
