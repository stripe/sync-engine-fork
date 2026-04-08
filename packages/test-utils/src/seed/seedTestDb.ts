import pg from 'pg'
import {
  DEFAULT_STORAGE_SCHEMA,
  ensureSchema,
  ensureObjectTable,
  upsertObjects,
  redactConnectionString,
} from '../db/storage.js'
import { resolveEndpointSet } from '../openapi/endpoints.js'
import { startDockerPostgres18, type DockerPostgres18Handle } from '../postgres/dockerPostgres18.js'
import { applyCreatedTimestampRange, resolveCreatedTimestampRange } from './createdTimestamps.js'
import {
  findSchemaNameByResourceId,
  generateObjectsFromSchema,
} from '@stripe/sync-openapi'

export type SeedTestDbOptions = {
  postgresUrl?: string
  schema?: string
  apiVersion?: string
  openApiSpecPath?: string
  /** How many objects to seed per endpoint. Defaults to 20. */
  count?: number
  /** @deprecated Use `count` instead. */
  limitPerEndpoint?: number
  tables?: string[]
  /** Start of created timestamp range (unix timestamp or date string). End defaults to now. */
  createdStart?: string | number
  /** End of created timestamp range (unix timestamp or date string). Defaults to now. */
  createdEnd?: string | number
  fetchImpl?: typeof globalThis.fetch
}

export type SeedEndpointResult = {
  tableName: string
  fetched: number
  inserted: number
  skipped?: string
}

export type SeedSummary = {
  apiVersion: string
  postgresUrl: string
  schema: string
  createdRange?: { startUnix: number; endUnix: number }
  totalObjects: number
  results: SeedEndpointResult[]
  skipped: SeedEndpointResult[]
}

export async function seedTestDb(options: SeedTestDbOptions = {}): Promise<SeedSummary> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const schema = options.schema ?? DEFAULT_STORAGE_SCHEMA
  const count = options.count ?? options.limitPerEndpoint ?? 20
  const createdRange = resolveCreatedTimestampRange({
    createdStart: options.createdStart,
    createdEnd: options.createdEnd,
  })
  const endpointSet = await resolveEndpointSet({
    apiVersion: options.apiVersion,
    openApiSpecPath: options.openApiSpecPath,
    fetchImpl,
  })

  let connectionString: string
  if (options.postgresUrl) {
    connectionString = options.postgresUrl
    process.stderr.write(`Using Postgres: ${redactConnectionString(connectionString)}\n`)
  } else {
    process.stderr.write('Starting Docker postgres:18 container...\n')
    const dockerHandle = await startDockerPostgres18()
    process.stderr.write(`Docker postgres:18 ready on port ${dockerHandle.hostPort}\n`)
    connectionString = dockerHandle.connectionString
  }

  const pool = new pg.Pool({ connectionString })
  try {
    await ensureSchema(pool, schema)

    const selected =
      options.tables && options.tables.length > 0
        ? [...endpointSet.endpoints.values()].filter((endpoint) =>
            options.tables?.includes(endpoint.tableName)
          )
        : [...endpointSet.endpoints.values()]

    const results: SeedEndpointResult[] = []
    const skipped: SeedEndpointResult[] = []
    let totalObjects = 0
    for (const endpoint of selected.sort((a, b) => a.tableName.localeCompare(b.tableName))) {
      const schemaName = findSchemaNameByResourceId(endpointSet.spec, endpoint.resourceId)
      if (!schemaName) {
        skipped.push({
          tableName: endpoint.tableName,
          fetched: 0,
          inserted: 0,
          skipped: 'no matching schema in spec',
        })
        continue
      }

      const rawRows = generateObjectsFromSchema(endpointSet.spec, schemaName, count, {
        tableName: endpoint.tableName,
      })

      const payloadRows = applyCreatedTimestampRange(rawRows, createdRange).filter(
        (obj) => typeof obj.id === 'string'
      )
      await ensureObjectTable(pool, schema, endpoint.tableName, endpoint.jsonSchema)
      const inserted = await upsertObjects(pool, schema, endpoint.tableName, payloadRows)

      results.push({
        tableName: endpoint.tableName,
        fetched: payloadRows.length,
        inserted,
      })
      totalObjects += inserted
    }

    return {
      apiVersion: endpointSet.apiVersion,
      postgresUrl: connectionString,
      schema,
      createdRange,
      totalObjects,
      results,
      skipped,
    }
  } finally {
    await pool.end().catch(() => undefined)
  }
}
