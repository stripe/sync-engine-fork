/**
 * PGlite Database Hydration Hook
 *
 * Provides client-side Postgres database powered by PGlite (WASM).
 * Hydrates from static JSON/SQL artifacts in the public directory.
 *
 * Usage:
 *   const { db, status, error, manifest } = usePGlite({ version: '2023-10-16' });
 *
 *   // Without a version, the hook remains idle.
 *
 *   if (status === 'loading') return <div>Loading database...</div>;
 *   if (status === 'error') return <div>Error: {error}</div>;
 */

import { PGlite } from '@electric-sql/pglite'
import { useEffect, useState, useRef } from 'react'

type PGliteInstance = InstanceType<typeof PGlite>

// Manifest structure from explorer-seed.ts
export interface ExplorerManifest {
  timestamp: string
  seed: number
  apiVersion: string
  totalTables: number
  coreTables: string[]
  longTailTables: string[]
  manifest: Record<string, number>
  failedTables: Array<{ table: string; reason: string }>
  verification: {
    allTablesSeeded: boolean
    tablesWithData: number
    emptyTables: string[]
  }
}

type DatabaseStatus = 'idle' | 'loading' | 'ready' | 'error'

type InitializedDatabase = {
  db: PGliteInstance
  manifest: ExplorerManifest
  version: string
}

// Version-keyed cache for shared database instances
const databaseCache = new Map<string, Promise<InitializedDatabase>>()

interface UsePGliteOptions {
  version?: string | null
}

interface UsePGliteResult {
  db: PGliteInstance | null
  status: DatabaseStatus
  error: string | null
  manifest: ExplorerManifest | null
  version: string | null
}

export function usePGlite(options?: UsePGliteOptions): UsePGliteResult {
  const { version = null } = options || {}

  const [db, setDb] = useState<PGliteInstance | null>(null)
  const [status, setStatus] = useState<DatabaseStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [manifest, setManifest] = useState<ExplorerManifest | null>(null)
  const [currentVersion, setCurrentVersion] = useState<string | null>(null)

  const currentPromiseRef = useRef<Promise<InitializedDatabase> | null>(null)
  const previousDbRef = useRef<PGliteInstance | null>(null)

  useEffect(() => {
    let cancelled = false

    // If version changed, destroy the old database instance
    if (previousDbRef.current && currentVersion !== version) {
      console.log(
        `[PGlite] Version changed from ${currentVersion} to ${version}, destroying old instance`
      )
      previousDbRef.current.close().catch((err) => {
        console.warn('[PGlite] Error closing previous database:', err)
      })
      previousDbRef.current = null
      setDb(null)
      setManifest(null)
      setCurrentVersion(null)
    }

    if (!version) {
      currentPromiseRef.current = null
      setStatus('idle')
      setError(null)
      return () => {
        cancelled = true
      }
    }

    setStatus('loading')
    setError(null)

    const databasePromise = getOrCreateDatabase(version)
    currentPromiseRef.current = databasePromise

    databasePromise
      .then(({ db: initializedDb, manifest: initializedManifest, version: loadedVersion }) => {
        if (cancelled) return

        // Check if a newer request has superseded this one
        if (currentPromiseRef.current !== databasePromise) {
          console.log('[PGlite] Ignoring stale database initialization')
          return
        }

        setManifest(initializedManifest)
        setDb(initializedDb)
        setCurrentVersion(loadedVersion)
        setStatus('ready')
        previousDbRef.current = initializedDb
      })
      .catch((err) => {
        console.error('[PGlite] Initialization error:', err)
        if (cancelled) return

        // Check if a newer request has superseded this one
        if (currentPromiseRef.current !== databasePromise) {
          console.log('[PGlite] Ignoring stale database error')
          return
        }

        setError(err instanceof Error ? err.message : 'Unknown error during initialization')
        setStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [version])

  return {
    db,
    status,
    error,
    manifest,
    version: currentVersion,
  }
}

async function hydrateSqlBootstrap(db: PGliteInstance, sqlPath: string): Promise<void> {
  console.log(`[PGlite] Fetching SQL bootstrap from ${sqlPath}`)

  const response = await fetch(sqlPath, {
    cache: 'no-store',
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch SQL bootstrap: ${response.status} ${response.statusText}`)
  }

  const sqlContent = await response.text()
  console.log(`[PGlite] SQL bootstrap size: ${(sqlContent.length / 1024).toFixed(2)} KB`)

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

  const cleanedSql = sqlContent
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return trimmed && !trimmed.startsWith('--')
    })
    .join('\n')

  const statements = cleanedSql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s + ';')

  console.log(`[PGlite] Executing ${statements.length} SQL statements individually...`)

  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i]
    try {
      await db.exec(statement)

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

async function hydrateJsonBootstrap(db: PGliteInstance, jsonPath: string): Promise<void> {
  console.log(`[PGlite] Fetching JSON bootstrap from ${jsonPath}`)

  const response = await fetch(jsonPath, {
    cache: 'no-store',
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch JSON bootstrap: ${response.status} ${response.statusText}`)
  }

  const jsonData = await response.json()
  console.log(
    `[PGlite] JSON bootstrap size: ${(JSON.stringify(jsonData).length / 1024).toFixed(2)} KB`
  )

  const tables = Object.keys(jsonData)
  console.log(`[PGlite] Hydrating ${tables.length} tables...`)

  for (const tableName of tables) {
    const rows = jsonData[tableName]
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log(`[PGlite] Skipping empty table: ${tableName}`)
      continue
    }

    console.log(`[PGlite] Inserting ${rows.length} rows into stripe.${tableName}...`)

    for (const row of rows) {
      try {
        await db.query(`INSERT INTO stripe.${tableName} (_raw_data, _account_id) VALUES ($1, $2)`, [
          JSON.stringify(row._raw_data),
          row._account_id,
        ])
      } catch (err) {
        console.error(`[PGlite] Error inserting row into ${tableName}:`, err)
      }
    }
  }

  console.log('[PGlite] JSON bootstrap loaded successfully')
}

function getArtifactPaths(version: string): {
  manifestPath: string
  sqlPath: string
  jsonPath: string
} {
  return {
    manifestPath: `/explorer-data/${version}/manifest.json`,
    sqlPath: `/explorer-data/${version}/bootstrap.sql`,
    jsonPath: `/explorer-data/${version}/bootstrap.json`,
  }
}

export async function createPGliteDatabase(version: string): Promise<{
  db: PGliteInstance
  manifest: ExplorerManifest
  version: string
}> {
  const paths = getArtifactPaths(version)

  console.log(`[PGlite] Creating database for version: ${version}`)
  console.log(`[PGlite] Manifest path: ${paths.manifestPath}`)

  const manifestResponse = await fetch(paths.manifestPath, {
    cache: 'no-store',
  })
  if (!manifestResponse.ok) {
    throw new Error(
      `Failed to fetch manifest from ${paths.manifestPath}: ${manifestResponse.status}`
    )
  }
  const manifest: ExplorerManifest = await manifestResponse.json()

  const db = await PGlite.create()

  // Try SQL bootstrap first, fall back to JSON
  const sqlCheckResponse = await fetch(paths.sqlPath, {
    method: 'HEAD',
    cache: 'no-store',
  })
  if (sqlCheckResponse.ok) {
    await hydrateSqlBootstrap(db, paths.sqlPath)
  } else {
    console.log(`[PGlite] SQL bootstrap not found at ${paths.sqlPath}, trying JSON`)
    await hydrateJsonBootstrap(db, paths.jsonPath)
  }

  return { db, manifest, version }
}

async function getOrCreateDatabase(version: string): Promise<InitializedDatabase> {
  const cacheKey = version

  if (!databaseCache.has(cacheKey)) {
    const databasePromise = createPGliteDatabase(version).catch((error) => {
      // Remove from cache on error so it can be retried
      databaseCache.delete(cacheKey)
      throw error
    })
    databaseCache.set(cacheKey, databasePromise)
  }

  return databaseCache.get(cacheKey)!
}
