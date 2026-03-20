import React, { useEffect, useState, type ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ProjectionConfig } from '@/types/projection'
import VisualizerClient from '../VisualizerClient'

vi.mock('next/dynamic', () => ({
  default: (
    loader: () => Promise<{ default: ComponentType<Record<string, unknown>> }>,
    options?: { loading?: ComponentType }
  ) => {
    function DynamicComponent(props: Record<string, unknown>) {
      const [Loaded, setLoaded] = useState<ComponentType<Record<string, unknown>> | null>(null)

      useEffect(() => {
        let active = true
        void loader().then((module) => {
          if (!active) return
          setLoaded(() => module.default)
        })
        return () => {
          active = false
        }
      }, [])

      if (Loaded) {
        return <Loaded {...props} />
      }

      const Loading = options?.loading
      return Loading ? <Loading /> : null
    }

    return DynamicComponent
  },
}))

vi.mock('@/lib/pglite', () => ({
  usePGlite: () => ({
    db: {} as object,
    status: 'ready' as const,
    error: null,
    manifest: {
      totalTables: 2,
      manifest: {
        charges: 10,
        customers: 5,
      },
    },
    version: '2026-02-24',
  }),
}))

vi.mock('@/lib/useVersionIndex', () => ({
  useVersionIndex: () => ({
    versionIndex: {
      defaultVersion: '2026-02-24',
      versions: [
        {
          apiVersion: '2026-02-24',
          label: '2026-02-24',
          manifestPath: '/explorer-data/2026-02-24/manifest.json',
          bootstrapPath: '/explorer-data/2026-02-24/bootstrap.sql',
          projectionPath: '/explorer-data/2026-02-24/projection.json',
          tableCount: 2,
          totalRows: 15,
        },
      ],
    },
    status: 'ready' as const,
    error: null,
  }),
}))

vi.mock('@/lib/useProjection', () => ({
  useProjection: () => {
    const [config, setConfigState] = useState<ProjectionConfig>({
      namespaceMode: 'both',
      listEndpointMode: 'yes',
      webhookEventMode: 'yes',
      fkMode: 'no',
      timestampMode: 'raw',
      deletedMode: 'column',
    })

    return {
      projectedModel: null,
      config,
      setConfig: (
        nextConfig: ProjectionConfig | ((previous: ProjectionConfig) => ProjectionConfig)
      ) => {
        setConfigState((previous) =>
          typeof nextConfig === 'function' ? nextConfig(previous) : nextConfig
        )
      },
      loadingState: 'fallback' as const,
      artifact: null,
      capabilities: null,
      error: null,
    }
  },
}))

vi.mock('@/components/ERDCanvas', () => ({
  default: ({
    projectionConfig,
    onProjectionConfigChange,
  }: {
    projectionConfig: ProjectionConfig
    onProjectionConfigChange: (
      updater: ProjectionConfig | ((previous: ProjectionConfig) => ProjectionConfig)
    ) => void
  }) => (
    <div data-testid="mock-erd-canvas">
      <p data-testid="fk-mode-value">{projectionConfig.fkMode}</p>
      <button
        type="button"
        onClick={() =>
          onProjectionConfigChange((previous) => ({
            ...previous,
            fkMode: 'yes',
          }))
        }
      >
        Enable relationship edges
      </button>
    </div>
  ),
}))

vi.mock('@/components/VersionPicker', () => ({
  default: () => <div data-testid="mock-version-picker" />,
}))

describe('VisualizerClient', () => {
  it('renders the ERD-only visualizer and wires projection controls into the canvas', async () => {
    render(<VisualizerClient />)

    expect(await screen.findByTestId('mock-erd-canvas')).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.queryByText(/explorer/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('fk-mode-value')).toHaveTextContent('no')

    fireEvent.click(screen.getByRole('button', { name: /enable relationship edges/i }))
    expect(screen.getByTestId('fk-mode-value')).toHaveTextContent('yes')
  })
})
