'use client'

import { memo, useCallback, type MouseEvent } from 'react'
import { Handle, Position } from '@xyflow/react'
import { ERD_NODE_DEFAULT_VISIBLE_COLUMNS } from '@/lib/erd-node-metrics'

export interface TableColumn {
  name: string
  type: string
  isPrimaryKey?: boolean
  isForeignKey?: boolean
  isNullable?: boolean
  isSoftDelete?: boolean
  // Projection-enhanced fields
  logicalType?: string // Logical type from projection (e.g., 'timestamptz' vs 'timestamp')
  materializedType?: string // Original SQL type (e.g., 'int8', 'text')
}

export interface ERDTableNodeData {
  tableName: string
  displayName?: string
  columns: TableColumn[]
  expanded?: boolean
  rowCount?: number
  // Projection-enhanced fields
  isDeletedVariant?: boolean // Whether this is a deleted-resource variant table
  isVirtual?: boolean // Whether this is a synthesized virtual table
  timestampMode?: 'raw' | 'timestamptz' // Current timestamp display mode
  onToggleExpand?: (tableName: string) => void
}

function ERDTableNode({ data }: { data: ERDTableNodeData }) {
  const {
    tableName,
    displayName,
    columns,
    expanded = false,
    rowCount,
    isDeletedVariant = false,
    isVirtual = false,
    timestampMode = 'raw',
    onToggleExpand,
  } = data
  const isExpanded = expanded
  const renderedName = displayName ?? tableName
  const showsAliasedName = renderedName !== tableName

  const hasMoreColumns = columns.length > ERD_NODE_DEFAULT_VISIBLE_COLUMNS
  const visibleColumns = isExpanded ? columns : columns.slice(0, ERD_NODE_DEFAULT_VISIBLE_COLUMNS)
  const hiddenCount = columns.length - ERD_NODE_DEFAULT_VISIBLE_COLUMNS

  const toggleExpanded = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      onToggleExpand?.(tableName)
    },
    [onToggleExpand, tableName]
  )

  // Determine which type to display based on mode and availability
  const getDisplayType = (column: TableColumn): string => {
    // Only swap the rendered type for projected timestamp columns.
    if (timestampMode === 'timestamptz' && column.logicalType === 'timestamptz') {
      return column.logicalType
    }

    return column.materializedType ?? column.type
  }

  const getColumnMeta = (column: TableColumn): string => {
    const tags: string[] = []

    if (column.isPrimaryKey) {
      tags.push('PK')
    } else if (column.isForeignKey) {
      tags.push('FK')
    }

    tags.push(getDisplayType(column))

    if (column.isNullable) {
      tags.push('NULL')
    }

    return tags.join(' · ')
  }

  const isDeleted = isDeletedVariant

  return (
    <article
      className={`erd-table-node min-w-[270px] max-w-[320px] overflow-hidden rounded-2xl border bg-white shadow-[0_2px_3px_rgba(15,23,42,0.08)] ${
        isDeleted ? 'border-rose-300' : 'border-slate-200'
      }`}
    >
      {/* Connection handles */}
      <Handle
        type="target"
        position={Position.Left}
        className={`table-node__handle !left-[-5px] !h-2 !w-2 !rounded-full !border !bg-white ${
          isDeleted ? '!border-rose-300' : '!border-slate-300'
        }`}
      />
      <Handle
        type="source"
        position={Position.Right}
        className={`table-node__handle !right-[-5px] !h-2 !w-2 !rounded-full !border !bg-white ${
          isDeleted ? '!border-rose-300' : '!border-slate-300'
        }`}
      />

      {/* Table Header */}
      <header
        className={`border-b px-3 py-2 ${
          isDeleted ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-slate-50'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3
              className={`truncate font-mono text-[12px] font-semibold tracking-[-0.01em] ${
                isDeleted ? 'text-rose-900' : 'text-slate-900'
              } ${isVirtual ? 'italic' : ''}`}
              title={showsAliasedName ? `${renderedName} (${tableName})` : renderedName}
            >
              {renderedName}
            </h3>
            {showsAliasedName && (
              <p className="mt-0.5 truncate font-mono text-[10px] text-slate-400">{tableName}</p>
            )}
            {(isDeletedVariant || isVirtual) && (
              <p
                className={`mt-0.5 text-[10px] font-medium ${isDeleted ? 'text-rose-500' : 'text-slate-500'}`}
              >
                {[isDeletedVariant ? 'Deleted variant' : null, isVirtual ? 'Virtual table' : null]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
          </div>
          {rowCount !== undefined && (
            <span
              className={`shrink-0 pt-0.5 text-[10px] font-medium ${isDeleted ? 'text-rose-400' : 'text-slate-500'}`}
            >
              {rowCount.toLocaleString()}
            </span>
          )}
        </div>
      </header>

      {/* Columns List — no height cap, canvas pan/zoom handles navigation */}
      <div className="bg-white px-2 py-1">
        {visibleColumns.map((column) => (
          <div
            key={column.name}
            className={`flex items-start justify-between gap-3 border-b border-dashed px-1 py-1.5 text-[11px] last:border-b-0 ${
              column.isSoftDelete ? 'border-rose-100 bg-rose-50/60' : 'border-slate-200'
            }`}
            title={`${column.name}: ${getDisplayType(column)}${column.isNullable ? ' (nullable)' : ''}`}
          >
            <span
              className={`min-w-0 flex-1 truncate font-mono ${
                column.isSoftDelete
                  ? 'font-medium text-rose-600'
                  : column.isPrimaryKey
                    ? 'font-semibold text-slate-900'
                    : 'font-medium text-slate-700'
              }`}
            >
              {column.name}
            </span>
            <span
              className={`shrink-0 whitespace-nowrap text-[10px] font-medium ${column.isSoftDelete ? 'text-rose-400' : 'text-slate-500'}`}
            >
              {getColumnMeta(column)}
            </span>
          </div>
        ))}
      </div>

      {/* Expand/Collapse Toggle */}
      {hasMoreColumns && (
        <footer className="border-t border-slate-200 bg-white px-3 py-2">
          <button
            type="button"
            onClick={toggleExpanded}
            className="nodrag nopan inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 transition-colors hover:text-indigo-700"
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? 'Show fewer columns' : 'Show more columns'} for ${tableName}`}
          >
            <svg
              className={`h-3 w-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
            <span>
              {isExpanded
                ? 'Show fewer columns'
                : `Show ${hiddenCount} more column${hiddenCount !== 1 ? 's' : ''}`}
            </span>
          </button>
        </footer>
      )}
    </article>
  )
}

// Export memoized version for performance with React Flow
export default memo(ERDTableNode)
