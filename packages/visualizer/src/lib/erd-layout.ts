/**
 * ERD Auto-Layout Utility using ELK (Eclipse Layout Kernel)
 *
 * This module provides layout functionality for Entity Relationship Diagrams (ERD).
 * It accepts table metadata (name, columns, expanded state) and produces positioned
 * node data compatible with React Flow.
 *
 * Features:
 * - Supports 100+ tables with non-overlapping layout
 * - Handles dynamic node heights based on expand/collapse state
 * - Works synchronously or asynchronously with elkjs
 * - Produces React Flow compatible node positions
 *
 * Usage:
 *   const tables = [
 *     { name: 'customers', columns: ['id', 'email', 'name'], expanded: true },
 *     { name: 'invoices', columns: ['id', 'customer_id', 'amount'], expanded: false },
 *   ];
 *   const nodes = await layoutERD(tables);
 *   // Use nodes with React Flow
 */

import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkNode, LayoutOptions } from 'elkjs'
import { ERD_NODE_WIDTH, estimateErdNodeHeight } from './erd-node-metrics'

// Module-level ELK singleton — creating a new instance per layout call spins up
// a new Web Worker each time, which is expensive for 100+ table schemas.
const elk = new ELK()

/**
 * Column metadata for a database table
 */
export interface TableColumn {
  name: string
  type?: string
  nullable?: boolean
  isPrimaryKey?: boolean
  isForeignKey?: boolean
}

/**
 * Table metadata for layout calculation
 */
export interface TableMetadata {
  name: string
  displayName?: string
  columns: TableColumn[] | string[] // Support both detailed columns and simple string arrays
  expanded: boolean
  rowCount?: number
  // Projection-enhanced fields
  isDeletedVariant?: boolean
  isVirtual?: boolean
  timestampMode?: 'raw' | 'timestamptz'
}

/**
 * Edge/relationship between tables
 */
export interface TableRelationship {
  fromTable: string
  fromColumn: string
  toTable: string
  toColumn: string
}

/**
 * React Flow compatible node
 */
export interface ERDNode {
  id: string
  type: string
  position: { x: number; y: number }
  data: {
    tableName: string
    displayName?: string
    columns: TableColumn[]
    expanded: boolean
    rowCount?: number
    // Projection-enhanced fields
    isDeletedVariant?: boolean
    isVirtual?: boolean
    timestampMode?: 'raw' | 'timestamptz'
  }
  width?: number
  height?: number
}

/**
 * React Flow compatible edge
 */
export interface ERDEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  type?: string
  label?: string
  labelShowBg?: boolean
  labelBgPadding?: [number, number]
  labelBgBorderRadius?: number
  labelStyle?: Record<string, string | number>
  labelBgStyle?: Record<string, string | number>
  data?: {
    fromColumn: string
    toColumn: string
  }
}

/**
 * Layout result containing nodes and edges
 */
export interface ERDLayoutResult {
  nodes: ERDNode[]
  edges: ERDEdge[]
}

/**
 * Layout configuration options
 */
export interface ERDLayoutOptions {
  direction?: 'DOWN' | 'RIGHT' | 'UP' | 'LEFT' // Layout direction
  nodeSpacing?: number // Minimum spacing between nodes (pixels)
  layerSpacing?: number // Spacing between hierarchical layers (pixels)
  algorithm?: 'layered' | 'force' | 'stress' | 'mrtree' // ELK algorithm
  edgeRouting?: 'ORTHOGONAL' | 'POLYLINE' | 'SPLINES' // Edge routing style
  measuredNodeSizes?: Record<string, { width: number; height: number }>
}

/**
 * Calculate node height based on column count and expanded state
 */
function calculateNodeHeight(table: TableMetadata, measuredHeight?: number): number {
  if (measuredHeight && measuredHeight > 0) {
    return measuredHeight
  }

  return estimateErdNodeHeight(table.columns.length, table.expanded)
}

/**
 * Normalize column data - convert string[] to TableColumn[]
 */
function normalizeColumns(columns: TableColumn[] | string[]): TableColumn[] {
  if (columns.length === 0) {
    return []
  }

  // Check if first element is a string
  if (typeof columns[0] === 'string') {
    return (columns as string[]).map((name) => ({ name }))
  }

  return columns as TableColumn[]
}

/**
 * Create ELK graph node from table metadata
 */
function createElkNode(
  table: TableMetadata,
  _index: number,
  measuredSize?: { width: number; height: number }
): ElkNode {
  const height = calculateNodeHeight(table, measuredSize?.height)

  return {
    id: table.name,
    width: measuredSize?.width && measuredSize.width > 0 ? measuredSize.width : ERD_NODE_WIDTH,
    height,
    // Add labels for better layout (optional, but can help some algorithms)
    labels: [{ text: table.displayName ?? table.name }],
  }
}

/**
 * Convert ELK layout result to React Flow nodes
 */
function elkToReactFlowNodes(elkNode: ElkNode, tables: TableMetadata[]): ERDNode[] {
  const nodes: ERDNode[] = []
  const tableMap = new Map(tables.map((t) => [t.name, t]))

  // Process child nodes
  if (elkNode.children) {
    for (const child of elkNode.children) {
      const table = tableMap.get(child.id)
      if (!table) continue

      nodes.push({
        id: child.id,
        type: 'erdTable',
        position: {
          x: child.x ?? 0,
          y: child.y ?? 0,
        },
        data: {
          tableName: table.name,
          displayName: table.displayName,
          columns: normalizeColumns(table.columns),
          expanded: table.expanded,
          rowCount: table.rowCount,
          // Pass through projection-enhanced fields
          isDeletedVariant: table.isDeletedVariant,
          isVirtual: table.isVirtual,
          timestampMode: table.timestampMode,
        },
        width: child.width,
        height: child.height,
      })
    }
  }

  return nodes
}

/**
 * Convert table relationships to React Flow edges
 */
function createReactFlowEdges(
  relationships: TableRelationship[],
  tableDisplayNames: Map<string, string>
): ERDEdge[] {
  return relationships.map((rel, index) => ({
    id: `e${index}-${rel.fromTable}-${rel.toTable}`,
    source: rel.fromTable,
    target: rel.toTable,
    type: 'step',
    label: `${rel.fromColumn} -> ${tableDisplayNames.get(rel.toTable) ?? rel.toTable}.${rel.toColumn}`,
    labelStyle: {
      fill: '#334155',
      fontSize: 11,
      fontWeight: 600,
    },
    data: {
      fromColumn: rel.fromColumn,
      toColumn: rel.toColumn,
    },
  }))
}

/**
 * Main layout function - produces positioned nodes for React Flow
 *
 * @param tables - Array of table metadata with columns and expanded state
 * @param relationships - Optional array of foreign key relationships
 * @param options - Layout configuration options
 * @returns Promise resolving to positioned ERD nodes and edges
 */
export async function layoutERD(
  tables: TableMetadata[],
  relationships: TableRelationship[] = [],
  options: ERDLayoutOptions = {}
): Promise<ERDLayoutResult> {
  const {
    direction = 'DOWN',
    nodeSpacing = 60,
    layerSpacing = 80,
    algorithm = 'layered',
    edgeRouting = 'ORTHOGONAL',
    measuredNodeSizes = {},
  } = options

  // Handle empty input
  if (tables.length === 0) {
    return { nodes: [], edges: [] }
  }

  // Convert tables to ELK nodes
  const elkNodes = tables.map((table, index) =>
    createElkNode(table, index, measuredNodeSizes[table.name])
  )
  const tableDisplayNames = new Map(
    tables.map((table) => [table.name, table.displayName ?? table.name])
  )

  // Convert relationships to ELK edges
  const elkEdges = relationships.map((rel, index) => ({
    id: `e${index}`,
    sources: [rel.fromTable],
    targets: [rel.toTable],
  }))

  // Configure ELK layout options
  const hasRelationships = relationships.length > 0
  const effectiveNodeSpacing = hasRelationships
    ? Math.max(nodeSpacing, 96)
    : Math.max(nodeSpacing, 72)
  const effectiveLayerSpacing = hasRelationships
    ? Math.max(layerSpacing, 180)
    : Math.max(layerSpacing, 120)

  const layoutOptions: LayoutOptions = {
    'elk.algorithm': algorithm,
    'elk.direction': direction,
    'elk.spacing.nodeNode': String(effectiveNodeSpacing),
    'elk.spacing.edgeNode': String(hasRelationships ? 48 : 32),
    'elk.spacing.edgeEdge': String(hasRelationships ? 24 : 16),
    'elk.spacing.componentComponent': String(hasRelationships ? 160 : 120),
    'elk.padding': '[top=32,left=32,bottom=32,right=32]',
    'elk.separateConnectedComponents': 'true',
    'elk.layered.spacing.nodeNodeBetweenLayers': String(effectiveLayerSpacing),
    'elk.layered.spacing.edgeNodeBetweenLayers': String(hasRelationships ? 80 : 48),
    'elk.edgeRouting': edgeRouting,
    // Additional options for better large-graph handling
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.nodePlacement.favorStraightEdges': hasRelationships ? 'true' : 'false',
    'elk.layered.nodePlacement.bk.fixedAlignment': hasRelationships ? 'BALANCED' : 'NONE',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.cycleBreaking.strategy': 'GREEDY',
    // Improve compactness for large graphs
    'elk.aspectRatio': hasRelationships ? '1.3' : '1.6',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  }

  // Build ELK graph
  const graph: ElkNode = {
    id: 'root',
    layoutOptions,
    children: elkNodes,
    edges: elkEdges,
  }

  try {
    // Run ELK layout algorithm
    const layoutResult = await elk.layout(graph)

    // Convert ELK result to React Flow nodes
    const nodes = elkToReactFlowNodes(layoutResult, tables)

    // Create React Flow edges
    const edges = createReactFlowEdges(relationships, tableDisplayNames)

    return { nodes, edges }
  } catch (error) {
    console.error('[ERD Layout] Layout computation failed:', error)
    // Fallback: return nodes in a simple grid layout
    return fallbackGridLayout(tables, relationships)
  }
}

/**
 * Fallback grid layout if ELK fails
 * Arranges nodes in a simple grid pattern
 */
function fallbackGridLayout(
  tables: TableMetadata[],
  relationships: TableRelationship[]
): ERDLayoutResult {
  const nodes: ERDNode[] = []
  const tableDisplayNames = new Map(
    tables.map((table) => [table.name, table.displayName ?? table.name])
  )
  const columns = Math.ceil(Math.sqrt(tables.length))
  const horizontalSpacing = ERD_NODE_WIDTH + 120
  const verticalSpacing = 320

  tables.forEach((table, index) => {
    const row = Math.floor(index / columns)
    const col = index % columns

    nodes.push({
      id: table.name,
      type: 'erdTable',
      position: {
        x: col * horizontalSpacing,
        y: row * verticalSpacing,
      },
      data: {
        tableName: table.name,
        displayName: table.displayName,
        columns: normalizeColumns(table.columns),
        expanded: table.expanded,
        rowCount: table.rowCount,
      },
      width: ERD_NODE_WIDTH,
      height: calculateNodeHeight(table),
    })
  })

  const edges = createReactFlowEdges(relationships, tableDisplayNames)

  return { nodes, edges }
}

/**
 * Synchronous layout wrapper (uses fallback grid layout)
 * Use this if you need immediate results without async/await
 */
export function layoutERDSync(
  tables: TableMetadata[],
  relationships: TableRelationship[] = []
): ERDLayoutResult {
  return fallbackGridLayout(tables, relationships)
}

/**
 * Re-layout only specific nodes after expand/collapse
 * More efficient than full re-layout for interactive operations
 *
 * @param currentNodes - Current node array
 * @param updatedTables - Tables that changed (expanded/collapsed)
 * @param allTables - Complete table metadata
 * @param relationships - Table relationships
 * @returns Promise with updated layout
 */
export async function relayoutPartial(
  currentNodes: ERDNode[],
  updatedTables: Set<string>,
  allTables: TableMetadata[],
  relationships: TableRelationship[] = []
): Promise<ERDLayoutResult> {
  // For now, do a full re-layout since ELK doesn't support incremental layout
  // In the future, we could implement a more sophisticated partial update
  // that only adjusts positions of affected nodes

  // Check if only heights changed (no topology change)
  const onlyHeightChanged = updatedTables.size < allTables.length * 0.3 // Less than 30% changed

  if (onlyHeightChanged) {
    // Simple vertical adjustment without full re-layout
    const updatedNodes = currentNodes.map((node) => {
      if (updatedTables.has(node.id)) {
        const table = allTables.find((t) => t.name === node.id)
        if (table) {
          return {
            ...node,
            height: calculateNodeHeight(table),
            data: {
              ...node.data,
              expanded: table.expanded,
            },
          }
        }
      }
      return node
    })

    return {
      nodes: updatedNodes,
      edges: createReactFlowEdges(
        relationships,
        new Map(allTables.map((table) => [table.name, table.displayName ?? table.name]))
      ),
    }
  }

  // Full re-layout for major changes
  return layoutERD(allTables, relationships)
}

/**
 * Calculate optimal viewport to fit all nodes
 * Useful for auto-zoom/fit-view functionality
 */
export function calculateViewportBounds(nodes: ERDNode[]): {
  x: number
  y: number
  width: number
  height: number
} {
  if (nodes.length === 0) {
    return { x: 0, y: 0, width: 800, height: 600 }
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const node of nodes) {
    minX = Math.min(minX, node.position.x)
    minY = Math.min(minY, node.position.y)
    maxX = Math.max(maxX, node.position.x + (node.width || ERD_NODE_WIDTH))
    maxY = Math.max(maxY, node.position.y + (node.height || estimateErdNodeHeight(0, false)))
  }

  const padding = 50

  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  }
}
