/**
 * Schema extraction utilities for ERD visualization
 * Queries PGlite information_schema to build table metadata
 */

import type { PGlite } from '@electric-sql/pglite'
import type { TableColumn, ERDTableNodeData } from '@/components/ERDTableNode'

interface ColumnInfo {
  column_name: string
  data_type: string
  is_nullable: string
  column_default: string | null
}

interface PrimaryKeyInfo {
  column_name: string
}

interface ForeignKeyInfo {
  column_name: string
  foreign_table_name: string
  foreign_column_name: string
}

/**
 * Extract schema information for a specific table
 */
export async function getTableSchema(
  db: PGlite,
  schemaName: string,
  tableName: string
): Promise<TableColumn[]> {
  try {
    // Get column information
    const columnsResult = await db.query<ColumnInfo>(
      `
      SELECT
        column_name,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
      ORDER BY ordinal_position
    `,
      [schemaName, tableName]
    )

    // Get primary key columns
    const pkResult = await db.query<PrimaryKeyInfo>(
      `
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = $1
        AND tc.table_name = $2
        AND tc.constraint_type = 'PRIMARY KEY'
    `,
      [schemaName, tableName]
    )

    // Get foreign key columns
    const fkResult = await db.query<ForeignKeyInfo>(
      `
      SELECT
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = $1
        AND tc.table_name = $2
    `,
      [schemaName, tableName]
    )

    const primaryKeys = new Set((pkResult.rows ?? []).map((row) => row.column_name))
    const foreignKeys = new Set((fkResult.rows ?? []).map((row) => row.column_name))

    const columns: TableColumn[] = (columnsResult.rows ?? []).map((col) => ({
      name: col.column_name,
      type: formatDataType(col.data_type),
      isPrimaryKey: primaryKeys.has(col.column_name),
      isForeignKey: foreignKeys.has(col.column_name),
      isNullable: col.is_nullable === 'YES',
    }))

    return columns
  } catch (error) {
    console.error(`[schema-utils] Error extracting schema for ${schemaName}.${tableName}:`, error)
    return []
  }
}

/**
 * Extract schema information for all tables in a schema
 */
export async function getAllTableSchemas(
  db: PGlite,
  schemaName: string = 'stripe',
  manifest?: Record<string, number>
): Promise<ERDTableNodeData[]> {
  try {
    // Get all table names
    const tablesResult = await db.query<{ table_name: string }>(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `,
      [schemaName]
    )

    const tables: ERDTableNodeData[] = []

    for (const row of tablesResult.rows ?? []) {
      const tableName = row.table_name
      const columns = await getTableSchema(db, schemaName, tableName)
      const rowCount = manifest?.[tableName]

      tables.push({
        tableName,
        columns,
        rowCount,
      })
    }

    return tables
  } catch (error) {
    console.error(`[schema-utils] Error extracting all table schemas:`, error)
    return []
  }
}

/**
 * Extract foreign key relationships between tables
 */
export async function getTableRelationships(
  db: PGlite,
  schemaName: string = 'stripe'
): Promise<
  Array<{
    fromTable: string
    fromColumn: string
    toTable: string
    toColumn: string
  }>
> {
  try {
    const result = await db.query<{
      table_name: string
      column_name: string
      foreign_table_name: string
      foreign_column_name: string
    }>(
      `
      SELECT
        tc.table_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = $1
      ORDER BY tc.table_name, kcu.column_name
    `,
      [schemaName]
    )

    return (result.rows ?? []).map((row) => ({
      fromTable: row.table_name,
      fromColumn: row.column_name,
      toTable: row.foreign_table_name,
      toColumn: row.foreign_column_name,
    }))
  } catch (error) {
    console.error(`[schema-utils] Error extracting relationships:`, error)
    return []
  }
}

/**
 * Format PostgreSQL data types for display
 */
function formatDataType(dataType: string): string {
  // Map verbose PostgreSQL types to shorter display names
  const typeMap: Record<string, string> = {
    'character varying': 'varchar',
    'timestamp with time zone': 'timestamptz',
    'timestamp without time zone': 'timestamp',
    'double precision': 'float8',
    integer: 'int4',
    bigint: 'int8',
    smallint: 'int2',
    boolean: 'bool',
  }

  return typeMap[dataType] || dataType
}

/**
 * Parse column type from generated column expression
 * Useful for extracting type from GENERATED ALWAYS AS columns
 */
export function parseGeneratedColumnType(expression: string): string {
  // Extract type casting from expressions like ((_raw_data ->> 'id'::text))
  const castMatch = expression.match(/::(\w+)/i)
  if (castMatch) {
    return formatDataType(castMatch[1])
  }

  // Default to text for jsonb extractions
  if (expression.includes('->')) {
    return 'jsonb'
  }
  if (expression.includes('->>')) {
    return 'text'
  }

  return 'unknown'
}
