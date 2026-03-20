import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjection } from '../useProjection'
import { DEFAULT_PROJECTION_CONFIG } from '@/types/projection'
import type { ProjectionArtifact } from '@/types/projection'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const mockArtifact: ProjectionArtifact = {
  apiVersion: '2026-02-24',
  generatedAt: '2026-03-17T00:00:00.000Z',
  capabilities: {
    hasV2Namespace: true,
    hasExplicitForeignKeys: false,
    hasDeletedVariants: true,
    hasListEndpointMetadata: true,
    hasWebhookEventMetadata: true,
    timestampFormat: 'mixed',
    tableCount: 2,
    relationshipCount: 1,
  },
  tables: {
    charges: {
      tableName: 'charges',
      namespace: 'v1',
      familyKey: 'charge',
      isCompatibilityOnly: false,
      isDeletedVariant: false,
      hasListEndpoint: true,
      hasWebhookEvent: true,
      columns: [
        {
          name: 'id',
          semanticTags: ['primary_key'],
          logicalType: 'id',
          nullable: false,
        },
      ],
    },
    customers: {
      tableName: 'customers',
      namespace: 'v2',
      familyKey: 'customer',
      isCompatibilityOnly: false,
      isDeletedVariant: false,
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
    },
  },
  relationships: [
    {
      fromTable: 'charges',
      fromColumn: 'customer',
      toTable: 'customers',
      toColumn: 'id',
      confidence: 'high',
    },
  ],
  deletedVariants: [],
}

describe('useProjection', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('stays idle without a version', () => {
    const { result } = renderHook(() => useProjection())

    expect(result.current.loadingState).toBe('idle')
    expect(result.current.projectedModel).toBeNull()
    expect(result.current.config).toEqual(DEFAULT_PROJECTION_CONFIG)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches projection artifacts and derives the default deployable view', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockArtifact,
    })

    const { result } = renderHook(() => useProjection({ version: '2026-02-24' }))

    await waitFor(() => {
      expect(result.current.loadingState).toBe('ready')
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/explorer-data/2026-02-24/projection.json',
      expect.any(Object)
    )
    expect(result.current.capabilities).toEqual(mockArtifact.capabilities)
    expect(result.current.config).toEqual(DEFAULT_PROJECTION_CONFIG)
    expect(result.current.projectedModel?.metadata.visibleTables).toBe(1)
    expect(result.current.projectedModel?.tables.charges).toBeDefined()
    expect(result.current.projectedModel?.tables.customers).toBeUndefined()
  })

  it('falls back cleanly on 404 and exposes disabled metadata capabilities', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    })

    const { result } = renderHook(() => useProjection({ version: '2025-01-27' }))

    await waitFor(() => {
      expect(result.current.loadingState).toBe('fallback')
    })

    expect(result.current.capabilities).toEqual({
      hasV2Namespace: false,
      hasExplicitForeignKeys: false,
      hasDeletedVariants: false,
      hasListEndpointMetadata: false,
      hasWebhookEventMetadata: false,
      timestampFormat: 'raw',
      tableCount: 0,
      relationshipCount: 0,
    })
    expect(result.current.artifact?.apiVersion).toBe('2025-01-27')
    expect(result.current.error).toBeNull()
  })

  it('normalizes unsupported filters against artifact capabilities', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ...mockArtifact,
        capabilities: {
          ...mockArtifact.capabilities,
          hasV2Namespace: false,
          hasDeletedVariants: false,
          hasListEndpointMetadata: false,
          hasWebhookEventMetadata: false,
        },
        tables: {
          charges: mockArtifact.tables.charges,
        },
        relationships: [],
      }),
    })

    const { result } = renderHook(() =>
      useProjection({
        version: '2025-01-27',
        initialConfig: {
          namespaceMode: 'v2',
          deletedMode: 'table',
          listEndpointMode: 'no',
          webhookEventMode: 'yes',
        },
      })
    )

    await waitFor(() => {
      expect(result.current.loadingState).toBe('ready')
    })

    expect(result.current.config.namespaceMode).toBe('v1')
    expect(result.current.config.deletedMode).toBe('column')
    expect(result.current.config.listEndpointMode).toBe('either')
    expect(result.current.config.webhookEventMode).toBe('either')
  })

  it('updates config without refetching', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockArtifact,
    })

    const { result } = renderHook(() => useProjection({ version: '2026-02-24' }))

    await waitFor(() => {
      expect(result.current.loadingState).toBe('ready')
    })

    const fetchCount = fetchMock.mock.calls.length

    act(() => {
      result.current.setConfig((previous) => ({
        ...previous,
        listEndpointMode: 'either',
        webhookEventMode: 'no',
        fkMode: 'yes',
      }))
    })

    await waitFor(() => {
      expect(result.current.config.listEndpointMode).toBe('either')
    })

    expect(result.current.config.webhookEventMode).toBe('no')
    expect(result.current.config.fkMode).toBe('yes')
    expect(fetchMock).toHaveBeenCalledTimes(fetchCount)
  })

  it('exposes error message on non-404 HTTP failures', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    })

    const { result } = renderHook(() => useProjection({ version: '2026-02-24' }))

    await waitFor(() => {
      expect(result.current.loadingState).toBe('idle')
    })

    expect(result.current.error).toBe('HTTP 500: Internal Server Error')
    expect(result.current.projectedModel).toBeNull()
  })

  it('exposes error message on network failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    const { result } = renderHook(() => useProjection({ version: '2026-02-24' }))

    await waitFor(() => {
      expect(result.current.loadingState).toBe('idle')
    })

    expect(result.current.error).toBe('Failed to fetch')
    expect(result.current.projectedModel).toBeNull()
  })

  it('exposes error message when artifact is missing required fields', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ apiVersion: '2026-02-24' }),
    })

    const { result } = renderHook(() => useProjection({ version: '2026-02-24' }))

    await waitFor(() => {
      expect(result.current.loadingState).toBe('idle')
    })

    expect(result.current.error).toBe('Invalid projection artifact structure')
    expect(result.current.projectedModel).toBeNull()
  })

  it('merges partial initialConfig with DEFAULT_PROJECTION_CONFIG', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockArtifact,
    })

    const { result } = renderHook(() =>
      useProjection({
        version: '2026-02-24',
        initialConfig: { namespaceMode: 'v1' },
      })
    )

    await waitFor(() => {
      expect(result.current.loadingState).toBe('ready')
    })

    expect(result.current.config.namespaceMode).toBe('v1')
    expect(result.current.config.listEndpointMode).toBe(DEFAULT_PROJECTION_CONFIG.listEndpointMode)
    expect(result.current.config.webhookEventMode).toBe(DEFAULT_PROJECTION_CONFIG.webhookEventMode)
    expect(result.current.config.fkMode).toBe(DEFAULT_PROJECTION_CONFIG.fkMode)
    expect(result.current.config.timestampMode).toBe(DEFAULT_PROJECTION_CONFIG.timestampMode)
    expect(result.current.config.deletedMode).toBe(DEFAULT_PROJECTION_CONFIG.deletedMode)
  })

  it('accepts direct-value form of setConfig without refetching', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockArtifact,
    })

    const { result } = renderHook(() => useProjection({ version: '2026-02-24' }))

    await waitFor(() => {
      expect(result.current.loadingState).toBe('ready')
    })

    const fetchCount = fetchMock.mock.calls.length

    act(() => {
      result.current.setConfig({ ...DEFAULT_PROJECTION_CONFIG, fkMode: 'yes' })
    })

    await waitFor(() => {
      expect(result.current.config.fkMode).toBe('yes')
    })

    expect(fetchMock).toHaveBeenCalledTimes(fetchCount)
  })

  it('ignores aborted stale requests and resolves the latest version', async () => {
    fetchMock
      .mockImplementationOnce((_url, init?: RequestInit) => {
        const signal = init?.signal
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ...mockArtifact,
          apiVersion: '2024-06-20',
        }),
      })

    const { result, rerender } = renderHook(({ version }) => useProjection({ version }), {
      initialProps: { version: '2023-10-16' },
    })

    rerender({ version: '2024-06-20' })

    await waitFor(() => {
      expect(result.current.loadingState).toBe('ready')
    })

    expect(result.current.artifact?.apiVersion).toBe('2024-06-20')
    expect(result.current.error).toBeNull()
  })
})
