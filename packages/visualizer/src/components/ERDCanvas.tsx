'use client'

/**
 * ERD Canvas Component
 *
 * Full-screen ERD visualization powered by React Flow + ELK layout.
 * Supports two data sources with automatic fallback:
 * 1. Projection-based model (from projection.json artifact)
 * 2. Information_schema queries (fallback when projection unavailable)
 *
 * Features:
 * - Uses projection artifacts for enhanced metadata and filtering
 * - Projection controls for namespace/FK/timestamp/deleted mode
 * - Queries PGlite information_schema as fallback
 * - Uses ELK layout algorithm for non-overlapping table placement
 * - Supports 100+ tables with minimal performance impact
 * - Pan, zoom, and drag interactions via React Flow
 * - Expand/collapse nodes with graceful re-layout
 * - Renders FK relationships as edges based on projection config
 */

import React, { useCallback, useEffect, useState, useRef } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeChange,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import type { PGlite } from '@electric-sql/pglite'
import ERDTableNode from './ERDTableNode'
import { layoutERD, type TableMetadata, type TableRelationship } from '@/lib/erd-layout'
import { getAllTableSchemas, getTableRelationships } from '@/lib/schema-utils'
import type { ExplorerManifest } from '@/lib/pglite'
import ProjectionControls from './ProjectionControls'
import type { ProjectedERDModel, ProjectedTable } from '@/lib/projection-engine'
import type { ProjectionArtifact, ProjectionColumn, ProjectionConfig } from '@/types/projection'
import type { TableColumn } from './ERDTableNode'

// Define custom node types for React Flow
const nodeTypes = {
  erdTable: ERDTableNode,
}

interface ERDCanvasProps {
  db: PGlite
  manifest: ExplorerManifest | null
  schemaName?: string
  projectedModel: ProjectedERDModel | null
  projectionConfig: ProjectionConfig
  onProjectionConfigChange: (
    config: ProjectionConfig | ((prev: ProjectionConfig) => ProjectionConfig)
  ) => void
  projectionLoadingState: 'idle' | 'loading' | 'ready' | 'fallback'
  projectionArtifact: ProjectionArtifact | null
}

/**
 * Convert ProjectionColumn to TableColumn format expected by ERDTableNode
 * Preserves both logicalType and materializedType for projection-aware display
 */
function projectionColumnToTableColumn(col: ProjectionColumn): TableColumn {
  return {
    name: col.name,
    type: col.materializedType ?? col.logicalType,
    logicalType: col.logicalType,
    materializedType: col.materializedType,
    isPrimaryKey: col.semanticTags.includes('primary_key'),
    isForeignKey:
      col.semanticTags.includes('foreign_key') || col.semanticTags.includes('expandable_ref'),
    isNullable: col.nullable,
    isSoftDelete: col.semanticTags.includes('soft_delete'),
  }
}

/**
 * Inner component that has access to React Flow context
 */
function ERDCanvasInner({
  db,
  manifest,
  schemaName = 'stripe',
  projectedModel,
  projectionConfig: config,
  onProjectionConfigChange: setConfig,
  projectionLoadingState: loadingState,
  projectionArtifact: artifact,
}: ERDCanvasProps) {
  const reactFlowInstance = useReactFlow()

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set())
  const [tableSchemas, setTableSchemas] = useState<TableMetadata[]>([])
  const [relationships, setRelationships] = useState<TableRelationship[]>([])

  // Track if we've done initial fit view
  const hasFitView = useRef(false)

  // Use measured React Flow node sizes for a second-pass layout that matches the DOM.
  const measuredNodeSizesRef = useRef<Record<string, { width: number; height: number }>>({})
  const relayoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const expandedTablesRef = useRef<Set<string>>(new Set())
  const measurementRelayoutArmedRef = useRef(false)

  // Stable refs for tableSchemas and relationships so handleNodesChange doesn't need
  // to close over state values (which would cause it to recreate on every schema update).
  const tableSchemasRef = useRef<TableMetadata[]>([])
  const relationshipsRef = useRef<TableRelationship[]>([])

  // Track memory usage if performance.memory is available
  useEffect(() => {
    if ('memory' in performance) {
      const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory
      if (mem) {
        const usedMB = (mem.usedJSHeapSize / 1024 / 1024).toFixed(2)
        console.log(`[ERD Canvas] Memory after hydration: ${usedMB} MB`)
      }
    }
  }, [])

  useEffect(() => {
    expandedTablesRef.current = expandedTables
  }, [expandedTables])

  const handleToggleTableExpand = useCallback(
    (tableName: string) => {
      setExpandedTables((prev) => {
        const next = new Set(prev)
        if (next.has(tableName)) {
          next.delete(tableName)
        } else {
          next.add(tableName)
        }
        expandedTablesRef.current = next
        return next
      })

      setNodes((prev) =>
        prev.map((node) =>
          node.id === tableName
            ? {
                ...node,
                data: {
                  ...node.data,
                  expanded: !node.data.expanded,
                },
              }
            : node
        )
      )
    },
    [setNodes]
  )

  /**
   * Load schema from projection model (preferred) or fallback to information_schema.
   *
   * Two distinct paths:
   * - Projection model present: synchronous derivation, NO loading flash. The model is
   *   already computed by useMemo in useProjection; we just reshape the data.
   * - No projection model: async DB query (initial load or version change), shows spinner.
   *
   * loadingState is intentionally excluded from deps — it cycles idle→loading→ready
   * during the projection artifact fetch and would cause spurious re-runs. projectedModel
   * being non-null is sufficient to know the artifact is ready.
   */
  const loadSchema = useCallback(async () => {
    if (!db) return

    const startTime = performance.now()

    if (projectedModel) {
      // Synchronous reshape — the heavy lifting was done in useProjection's useMemo.
      const tableMeta: TableMetadata[] = Object.values(projectedModel.tables).map(
        (table: ProjectedTable) => ({
          name: table.tableName,
          displayName: table.displayName,
          columns: table.columns.map(projectionColumnToTableColumn),
          expanded: expandedTablesRef.current.has(table.tableName),
          rowCount: table.rowCount,
          isDeletedVariant: table.isDeletedVariant,
          isVirtual: table.isVirtual,
          timestampMode: config.timestampMode,
        })
      )

      const rels: TableRelationship[] = projectedModel.relationships.map((rel) => ({
        fromTable: rel.fromTable,
        fromColumn: rel.fromColumn,
        toTable: rel.toTable,
        toColumn: rel.toColumn,
      }))

      console.log(
        `[ERD Canvas] Projection model: ${tableMeta.length} tables, ${rels.length} rels`,
        projectedModel.metadata
      )

      tableSchemasRef.current = tableMeta
      relationshipsRef.current = rels
      setTableSchemas(tableMeta)
      setRelationships(rels)
      setError(null)
      setIsLoading(false)

      console.log(
        `[ERD Canvas] Schema from projection in ${(performance.now() - startTime).toFixed(2)}ms`
      )
      return
    }

    // Async path — initial load or version change with no projection artifact yet.
    setIsLoading(true)
    setError(null)

    try {
      console.log('[ERD Canvas] Loading schema from PGlite information_schema (fallback)...')

      const tables = await getAllTableSchemas(db, schemaName, manifest?.manifest)
      const rels = await getTableRelationships(db, schemaName)

      console.log(
        `[ERD Canvas] Discovered ${tables.length} tables, ${rels.length} FK relationships`
      )

      const tableMeta: TableMetadata[] = tables.map((table) => ({
        name: table.tableName,
        columns: table.columns,
        expanded: expandedTablesRef.current.has(table.tableName),
        rowCount: table.rowCount,
      }))

      tableSchemasRef.current = tableMeta
      relationshipsRef.current = rels
      setTableSchemas(tableMeta)
      setRelationships(rels)

      console.log(
        `[ERD Canvas] Schema from information_schema in ${(performance.now() - startTime).toFixed(2)}ms`
      )
    } catch (err) {
      console.error('[ERD Canvas] Failed to load schema:', err)
      setError(err instanceof Error ? err.message : 'Failed to load schema')
    } finally {
      setIsLoading(false)
    }
  }, [db, schemaName, manifest, projectedModel, config])

  // Stable reference so MiniMap doesn't re-render on every parent render.
  const minimapNodeColor = useCallback((node: Node) => {
    const data = node.data as { rowCount?: number; isDeletedVariant?: boolean }
    if (data.isDeletedVariant) return '#fda4af' // rose for deleted-variant tables
    if (data.rowCount && data.rowCount > 1000) return '#4f46e5'
    if (data.rowCount && data.rowCount > 100) return '#6366f1'
    return '#94a3b8'
  }, [])

  /**
   * Run ELK layout and update nodes/edges
   */
  const runLayout = useCallback(
    async (tables: TableMetadata[], rels: TableRelationship[]) => {
      console.log('[ERD Canvas] Running ELK layout...')
      const startTime = performance.now()

      try {
        const result = await layoutERD(tables, rels, {
          direction: 'DOWN',
          nodeSpacing: rels.length > 0 ? 110 : 84,
          layerSpacing: rels.length > 0 ? 190 : 132,
          algorithm: 'layered',
          edgeRouting: 'ORTHOGONAL',
          measuredNodeSizes: measuredNodeSizesRef.current,
        })

        setNodes(
          result.nodes.map((node) => ({
            ...node,
            data: {
              ...node.data,
              onToggleExpand: handleToggleTableExpand,
            },
          }))
        )
        setEdges(result.edges)

        const elapsed = (performance.now() - startTime).toFixed(2)
        console.log(`[ERD Canvas] Layout completed in ${elapsed}ms`)

        // Fit view on initial load
        if (!hasFitView.current && result.nodes.length > 0) {
          setTimeout(() => {
            reactFlowInstance.fitView({ padding: 0.1, duration: 400 })
            hasFitView.current = true
          }, 50)
        }
      } catch (err) {
        console.error('[ERD Canvas] Layout failed:', err)
        setError('Failed to compute layout')
      }
    },
    [handleToggleTableExpand, reactFlowInstance, setNodes, setEdges]
  )

  useEffect(() => {
    return () => {
      if (relayoutTimerRef.current) {
        clearTimeout(relayoutTimerRef.current)
      }
    }
  }, [])

  /**
   * Initial schema load - triggered when projection model or db changes
   */
  useEffect(() => {
    loadSchema()
  }, [loadSchema])

  /**
   * Layout when schema changes
   */
  useEffect(() => {
    if (tableSchemas.length > 0) {
      measurementRelayoutArmedRef.current = true
      runLayout(tableSchemas, relationships)
    }
  }, [tableSchemas, relationships, runLayout])

  /**
   * Handle node expand/collapse
   * React Flow doesn't provide built-in events for this, so we detect
   * changes via onNodesChange and check for dimension updates
   */
  // Uses refs instead of state so this callback stays stable across schema updates.
  // A stable onNodesChange identity prevents React Flow from resetting internal state
  // on every config change.
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes)

      let measuredSizeChanged = false
      const nextMeasuredSizes = { ...measuredNodeSizesRef.current }

      for (const change of changes) {
        if (change.type !== 'dimensions' || !('dimensions' in change) || !change.dimensions) {
          continue
        }

        const width = Math.round(change.dimensions.width ?? 0)
        const height = Math.round(change.dimensions.height ?? 0)
        if (width <= 0 || height <= 0) {
          continue
        }

        const previous = measuredNodeSizesRef.current[change.id]
        if (!previous || previous.width !== width || previous.height !== height) {
          nextMeasuredSizes[change.id] = { width, height }
          measuredSizeChanged = true
        }
      }

      if (!measuredSizeChanged || tableSchemasRef.current.length === 0) {
        return
      }

      measuredNodeSizesRef.current = nextMeasuredSizes

      if (!measurementRelayoutArmedRef.current) {
        return
      }

      measurementRelayoutArmedRef.current = false

      if (relayoutTimerRef.current) {
        clearTimeout(relayoutTimerRef.current)
      }

      relayoutTimerRef.current = setTimeout(() => {
        relayoutTimerRef.current = null
        console.log('[ERD Canvas] Re-running layout with measured node dimensions')
        runLayout(tableSchemasRef.current, relationshipsRef.current)
      }, 40)
    },
    [onNodesChange, runLayout]
  )

  /**
   * Render loading state
   */
  if (isLoading || loadingState === 'loading') {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="mb-4 h-12 w-12 animate-spin rounded-full border-4 border-slate-300 border-t-indigo-600 mx-auto" />
          <p className="text-sm font-medium text-slate-700">
            {loadingState === 'loading'
              ? 'Loading projection artifact...'
              : 'Loading database schema...'}
          </p>
          <p className="text-xs text-slate-500 mt-1">This may take a moment for large schemas</p>
        </div>
      </div>
    )
  }

  /**
   * Render error state
   */
  if (error) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-50">
        <div className="max-w-md rounded-lg border border-red-200 bg-red-50 p-6 text-center">
          <div className="mb-3 text-red-600">
            <svg
              className="mx-auto h-10 w-10"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <h3 className="mb-2 text-lg font-semibold text-red-900">Failed to load ERD</h3>
          <p className="text-sm text-red-700">{error}</p>
        </div>
      </div>
    )
  }

  /**
   * Render empty state
   */
  if (nodes.length === 0) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="mb-3 text-slate-400">
            <svg
              className="mx-auto h-16 w-16"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7c0-2-1-3-3-3H7C5 4 4 5 4 7z"
              />
            </svg>
          </div>
          <h3 className="mb-1 text-lg font-medium text-slate-700">No tables found</h3>
          <p className="text-sm text-slate-500">
            The database schema appears to be empty or not loaded.
          </p>
        </div>
      </div>
    )
  }

  /**
   * Render ERD canvas
   */
  return (
    <div className="h-screen w-full bg-white">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView={false} // We handle fitView manually
        minZoom={0.05}
        maxZoom={1.5}
        defaultEdgeOptions={{
          type: 'step',
          style: { stroke: '#6366f1', strokeWidth: 1.5 },
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} color="#cbd5e1" gap={22} size={1.1} />
        <Controls className="!border-slate-300 !bg-white !shadow-lg" showInteractive={false} />
        <MiniMap
          className="!border !border-slate-300 !bg-slate-100"
          nodeColor={minimapNodeColor}
          maskColor="rgba(0, 0, 0, 0.05)"
          pannable
          zoomable
        />

        {/* Info overlay */}
        <div className="absolute left-4 top-4 z-10 min-w-[280px] max-w-sm rounded-3xl border border-slate-200 bg-white/95 px-4 py-3 shadow-[0_2px_3px_rgba(15,23,42,0.08)] backdrop-blur-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold tracking-[-0.01em] text-slate-900">ERD Canvas</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {nodes.length} table{nodes.length !== 1 ? 's' : ''} · {edges.length} relationship
                {edges.length !== 1 ? 's' : ''}
              </p>
            </div>
            <div className="text-right text-[11px] font-medium text-slate-500">
              {loadingState === 'ready' ? 'Projection model' : 'Fallback mode'}
            </div>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            Click a table to move it. Use the footer toggle to show more columns.
          </p>
          <p className="mt-1 text-[11px] text-slate-400">
            {config.fkMode === 'yes' ? 'Relationship edges visible' : 'Relationship edges hidden'}
          </p>
        </div>

        {/* Projection Controls - only show when projection is available */}
        {(loadingState === 'ready' || loadingState === 'fallback') && (
          <ProjectionControls config={config} onChange={setConfig} artifact={artifact} />
        )}
      </ReactFlow>
    </div>
  )
}

/**
 * Main ERD Canvas component with React Flow provider
 */
export default function ERDCanvas(props: ERDCanvasProps) {
  return (
    <ReactFlowProvider>
      <ERDCanvasInner {...props} />
    </ReactFlowProvider>
  )
}
