import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ERDCanvas from '../ERDCanvas'
import { DEFAULT_PROJECTION_CONFIG } from '@/types/projection'
import type { ProjectedERDModel } from '@/lib/projection-engine'

vi.mock('@xyflow/react', async () => {
  const ReactModule = await import('react')

  return {
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ReactFlow: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="react-flow">{children}</div>
    ),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    BackgroundVariant: { Dots: 'dots' },
    useReactFlow: () => ({
      fitView: vi.fn(),
    }),
    useNodesState: (initialNodes: unknown[]) => {
      const [nodes, setNodes] = ReactModule.useState(initialNodes)
      return [nodes, setNodes, vi.fn()] as const
    },
    useEdgesState: (initialEdges: unknown[]) => {
      const [edges, setEdges] = ReactModule.useState(initialEdges)
      return [edges, setEdges, vi.fn()] as const
    },
  }
})

vi.mock('../ERDTableNode', () => ({
  default: () => null,
}))

vi.mock('@/lib/erd-layout', () => ({
  layoutERD: vi.fn(
    async (tables: Array<{ name: string; columns: unknown[] }>, relationships: unknown[]) => ({
      nodes: tables.map((table, index) => ({
        id: table.name,
        type: 'erdTable',
        position: { x: index * 100, y: 0 },
        data: {
          tableName: table.name,
          columns: table.columns,
          expanded: true,
        },
      })),
      edges: relationships.map((relationship, index) => ({
        id: `edge-${index}`,
        source: (relationship as { fromTable: string }).fromTable,
        target: (relationship as { toTable: string }).toTable,
      })),
    })
  ),
}))

describe('ERDCanvas', () => {
  it('clears the loading state when a projected model is available', async () => {
    const projectedModel: ProjectedERDModel = {
      tables: {
        charges: {
          tableName: 'charges',
          namespace: 'v1',
          familyKey: 'charge',
          isCompatibilityOnly: false,
          isDeletedVariant: false,
          isVirtual: false,
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
      },
      relationships: [],
      metadata: {
        totalTables: 1,
        visibleTables: 1,
        totalRelationships: 0,
        visibleRelationships: 0,
        virtualTablesAdded: 0,
        timestampColumnsTransformed: 0,
        deletedFlagsRemoved: 0,
        appliedConfig: DEFAULT_PROJECTION_CONFIG,
      },
    }

    render(
      <ERDCanvas
        db={{} as never}
        manifest={null}
        projectedModel={projectedModel}
        projectionConfig={DEFAULT_PROJECTION_CONFIG}
        onProjectionConfigChange={vi.fn()}
        projectionLoadingState="ready"
        projectionArtifact={null}
      />
    )

    await waitFor(() => {
      expect(screen.queryByText(/loading database schema/i)).not.toBeInTheDocument()
    })

    expect(screen.getByText('ERD Canvas')).toBeInTheDocument()
  })
})
