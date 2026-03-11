/**
 * PGlite Database Hydration Hook
 *
 * Provides client-side Postgres database powered by PGlite (WASM).
 * Hydrates from static JSON/SQL artifacts in the public directory.
 *
 * Usage:
 *   const { db, status, error, query } = usePGlite();
 *
 *   if (status === 'loading') return <div>Loading database...</div>;
 *   if (status === 'error') return <div>Error: {error}</div>;
 *
 *   const result = await query('SELECT * FROM stripe.customers LIMIT 10');
 */

import { useEffect, useState, useCallback, useRef } from 'react'

// PGlite types - these will be properly typed when @electric-sql/pglite is installed
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PGliteInstance = any
type QueryResult = {
  rows: Record<string, unknown>[]
  fields: { name: string; dataTypeID: number }[]
  rowCount: number
}

// Manifest structure from explorer-seed.ts
interface ExplorerManifest {
  timestamp: string
  seed: number
  apiVersion: string
  totalTables: number
  coreTables: string[]
  longTailTables: string[]
  manifest: Record<string, number> // table name -> row count
  failedTables: Array<{ table: string; reason: string }>
  verification: {
    allTablesSeeded: boolean
    tablesWithData: number
    emptyTables: string[]
  }
}

// Data artifact structure - can be SQL dump or JSON
interface DataArtifact {
  format: 'sql' | 'json'
  path: string // relative to public/explorer-data/
  tables: string[] // list of tables included
}

type DatabaseStatus = 'idle' | 'loading' | 'ready' | 'error'

interface UsePGliteResult {
  /** PGlite database instance (null until ready) */
  db: PGliteInstance | null
  /** Current status of database initialization */
  status: DatabaseStatus
  /** Error message if status is 'error' */
  error: string | null
  /** Execute a SQL query against the database */
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>
  /** Execute a SQL command (INSERT, UPDATE, DELETE) */
  exec: (sql: string) => Promise<void>
  /** Manifest of available tables and row counts */
  manifest: ExplorerManifest | null
}

/**
 * React hook for initializing and using PGlite database
 *
 * Initialization flow:
 * 1. Fetch manifest.json from /explorer-data/manifest.json
 * 2. Discover data artifact path (SQL or JSON format)
 * 3. Initialize PGlite instance
 * 4. Hydrate database with artifact data
 * 5. Mark as ready for queries
 */
export function usePGlite(): UsePGliteResult {
  const [db, setDb] = useState<PGliteInstance | null>(null)
  const [status, setStatus] = useState<DatabaseStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [manifest, setManifest] = useState<ExplorerManifest | null>(null)

  // Use ref to prevent double initialization in strict mode
  const initRef = useRef(false)

  useEffect(() => {
    // Prevent double initialization
    if (initRef.current) return
    initRef.current = true

    let mounted = true

    async function initializeDatabase() {
      try {
        setStatus('loading')
        setError(null)

        // Step 1: Fetch manifest from public directory
        console.log('[PGlite] Fetching manifest from /explorer-data/manifest.json')
        const manifestResponse = await fetch('/explorer-data/manifest.json')

        if (!manifestResponse.ok) {
          throw new Error(
            `Failed to fetch manifest: ${manifestResponse.status} ${manifestResponse.statusText}`
          )
        }

        const manifestData: ExplorerManifest = await manifestResponse.json()
        console.log('[PGlite] Manifest loaded:', {
          totalTables: manifestData.totalTables,
          coreTables: manifestData.coreTables.length,
          longTailTables: manifestData.longTailTables.length,
        })

        if (!mounted) return
        setManifest(manifestData)

        // Step 2: Discover data artifact
        // Try SQL format first (more efficient), fallback to JSON
        let dataArtifact: DataArtifact | null = null

        // Check for SQL dump
        const sqlCheckResponse = await fetch('/explorer-data/bootstrap.sql', { method: 'HEAD' })
        if (sqlCheckResponse.ok) {
          dataArtifact = {
            format: 'sql',
            path: '/explorer-data/bootstrap.sql',
            tables: Object.keys(manifestData.manifest),
          }
          console.log('[PGlite] Found SQL bootstrap artifact')
        } else {
          // Check for JSON dump
          const jsonCheckResponse = await fetch('/explorer-data/bootstrap.json', { method: 'HEAD' })
          if (jsonCheckResponse.ok) {
            dataArtifact = {
              format: 'json',
              path: '/explorer-data/bootstrap.json',
              tables: Object.keys(manifestData.manifest),
            }
            console.log('[PGlite] Found JSON bootstrap artifact')
          }
        }

        if (!dataArtifact) {
          throw new Error(
            'No data artifact found. Expected /explorer-data/bootstrap.sql or bootstrap.json'
          )
        }

        // Step 3: Initialize PGlite
        console.log('[PGlite] Initializing PGlite instance...')

        // Dynamic import to avoid SSR issues
        const { PGlite } = await import('@electric-sql/pglite')
        const pgliteInstance = await PGlite.create()

        console.log('[PGlite] PGlite instance created')

        if (!mounted) return

        // Step 4: Hydrate database
        console.log(`[PGlite] Hydrating database from ${dataArtifact.format} artifact...`)

        if (dataArtifact.format === 'sql') {
          await hydrateSqlBootstrap(pgliteInstance, dataArtifact.path)
        } else {
          await hydrateJsonBootstrap(pgliteInstance, dataArtifact.path, manifestData)
        }

        console.log('[PGlite] Database hydration complete')
        console.log('[PGlite] Ready for queries')

        if (!mounted) return

        setDb(pgliteInstance)
        setStatus('ready')
      } catch (err) {
        console.error('[PGlite] Initialization error:', err)

        if (!mounted) return

        setError(err instanceof Error ? err.message : 'Unknown error during initialization')
        setStatus('error')
      }
    }

    initializeDatabase()

    return () => {
      mounted = false
    }
  }, [])

  // Query function with validation
  const query = useCallback(
    async (sql: string, params?: unknown[]): Promise<QueryResult> => {
      if (status !== 'ready' || !db) {
        throw new Error('Database not ready. Current status: ' + status)
      }

      try {
        const result = await db.query(sql, params)
        return result
      } catch (err) {
        console.error('[PGlite] Query error:', err)
        throw err
      }
    },
    [db, status]
  )

  // Exec function for commands without results
  const exec = useCallback(
    async (sql: string): Promise<void> => {
      if (status !== 'ready' || !db) {
        throw new Error('Database not ready. Current status: ' + status)
      }

      try {
        await db.exec(sql)
      } catch (err) {
        console.error('[PGlite] Exec error:', err)
        throw err
      }
    },
    [db, status]
  )

  return {
    db,
    status,
    error,
    query,
    exec,
    manifest,
  }
}

/**
 * Hydrate PGlite from SQL bootstrap file
 * Most efficient format - direct SQL execution
 */
async function hydrateSqlBootstrap(db: PGliteInstance, sqlPath: string): Promise<void> {
  console.log(`[PGlite] Fetching SQL bootstrap from ${sqlPath}`)

  const response = await fetch(sqlPath)
  if (!response.ok) {
    throw new Error(`Failed to fetch SQL bootstrap: ${response.status} ${response.statusText}`)
  }

  const sqlContent = await response.text()
  console.log(`[PGlite] SQL bootstrap size: ${(sqlContent.length / 1024).toFixed(2)} KB`)

  // PGlite's exec() method supports multi-statement SQL
  // Try to execute the entire SQL content as a single string first (simplest and most robust)
  try {
    console.log(`[PGlite] Attempting to execute SQL as single multi-statement block...`)
    await db.exec(sqlContent)
    console.log('[PGlite] SQL bootstrap executed successfully')
    return
  } catch (err) {
    console.warn(
      '[PGlite] Multi-statement execution failed, falling back to statement-by-statement execution'
    )
    console.warn('[PGlite] Error was:', err instanceof Error ? err.message : String(err))
  }

  // Fallback: execute statement by statement
  // Strip comments and split on semicolons, preserving the semicolon
  const cleanedSql = sqlContent
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return trimmed && !trimmed.startsWith('--')
    })
    .join('\n')

  // Split on semicolons but preserve them for execution
  const statements = cleanedSql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s + ';') // Append semicolon back

  console.log(`[PGlite] Executing ${statements.length} SQL statements individually...`)

  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i]
    try {
      await db.exec(statement)

      // Log progress every 100 statements
      if ((i + 1) % 100 === 0) {
        console.log(`[PGlite] Progress: ${i + 1}/${statements.length} statements`)
      }
    } catch (err) {
      const preview = statement.length > 200 ? statement.substring(0, 200) + '...' : statement
      console.error(`[PGlite] Error executing statement ${i + 1}:`, preview)
      console.error('[PGlite] Full error:', err)
      throw new Error(
        `Failed to execute SQL statement ${i + 1}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  console.log('[PGlite] SQL bootstrap executed successfully (statement-by-statement mode)')
}

/**
 * Hydrate PGlite from JSON bootstrap file
 * Fallback format - reconstructs INSERTs from JSON data
 */
async function hydrateJsonBootstrap(
  db: PGliteInstance,
  jsonPath: string,
  _manifest: ExplorerManifest
): Promise<void> {
  console.log(`[PGlite] Fetching JSON bootstrap from ${jsonPath}`)

  const response = await fetch(jsonPath)
  if (!response.ok) {
    throw new Error(`Failed to fetch JSON bootstrap: ${response.status} ${response.statusText}`)
  }

  const jsonData = await response.json()
  console.log(
    `[PGlite] JSON bootstrap size: ${(JSON.stringify(jsonData).length / 1024).toFixed(2)} KB`
  )

  // JSON format: { tableName: [{ row1 }, { row2 }], ... }
  const tables = Object.keys(jsonData)
  console.log(`[PGlite] Hydrating ${tables.length} tables...`)

  for (const tableName of tables) {
    const rows = jsonData[tableName]
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log(`[PGlite] Skipping empty table: ${tableName}`)
      continue
    }

    console.log(`[PGlite] Inserting ${rows.length} rows into stripe.${tableName}...`)

    // Insert rows using parameterized queries
    // Assumes table structure: (_raw_data JSONB, _account_id TEXT)
    for (const row of rows) {
      try {
        await db.query(`INSERT INTO stripe.${tableName} (_raw_data, _account_id) VALUES ($1, $2)`, [
          JSON.stringify(row._raw_data),
          row._account_id,
        ])
      } catch (err) {
        console.error(`[PGlite] Error inserting row into ${tableName}:`, err)
        // Continue with other rows - don't fail entire hydration
      }
    }
  }

  console.log('[PGlite] JSON bootstrap loaded successfully')
}

/**
 * Standalone function to initialize PGlite without React hooks
 * Useful for non-React contexts or server-side scripts
 */
export async function createPGliteDatabase(): Promise<{
  db: PGliteInstance
  manifest: ExplorerManifest
}> {
  // Fetch manifest
  const manifestResponse = await fetch('/explorer-data/manifest.json')
  if (!manifestResponse.ok) {
    throw new Error(`Failed to fetch manifest: ${manifestResponse.status}`)
  }
  const manifest: ExplorerManifest = await manifestResponse.json()

  // Initialize PGlite
  const { PGlite } = await import('@electric-sql/pglite')
  const db = await PGlite.create()

  // Discover and hydrate
  const sqlCheckResponse = await fetch('/explorer-data/bootstrap.sql', { method: 'HEAD' })
  if (sqlCheckResponse.ok) {
    await hydrateSqlBootstrap(db, '/explorer-data/bootstrap.sql')
  } else {
    await hydrateJsonBootstrap(db, '/explorer-data/bootstrap.json', manifest)
  }

  return { db, manifest }
}
