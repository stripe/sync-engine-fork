import { Client } from 'pg'
import { migrate } from 'pg-node-migrations'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import type { ConnectionOptions } from 'node:tls'
import type { Logger } from '../types'
import { SIGMA_INGESTION_CONFIGS } from '../sigma/sigmaIngestionConfigs'
import type { SigmaIngestionConfig } from '../sigma/sigmaIngestion'
import type { EmbeddedMigration } from './migrations-embedded'

// Get __dirname equivalent for ESM
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SIGMA_BASE_COLUMNS = ['_raw_data', '_last_synced_at', '_updated_at', '_account_id'] as const
// Postgres identifiers are capped at 63 bytes; long Sigma column names can collide after truncation.
const PG_IDENTIFIER_MAX_BYTES = 63
const SIGMA_COLUMN_HASH_PREFIX = '_h'
const SIGMA_COLUMN_HASH_BYTES = 8

type MigrationConfig = {
  databaseUrl: string
  ssl?: ConnectionOptions
  logger?: Logger
  enableSigma?: boolean
}

function truncateIdentifier(name: string, maxBytes: number): string {
  if (Buffer.byteLength(name) <= maxBytes) return name
  return Buffer.from(name).subarray(0, maxBytes).toString('utf8')
}

function buildColumnHashSuffix(name: string): string {
  const hash = createHash('sha1').update(name).digest('hex').slice(0, SIGMA_COLUMN_HASH_BYTES)
  return `${SIGMA_COLUMN_HASH_PREFIX}${hash}`
}

function ensureUniqueIdentifier(name: string, used: Set<string>): string {
  const truncated = truncateIdentifier(name, PG_IDENTIFIER_MAX_BYTES)
  if (!used.has(truncated)) {
    return truncated
  }

  const baseSuffix = buildColumnHashSuffix(name)
  for (let counter = 0; counter < 10_000; counter += 1) {
    const suffix = counter === 0 ? baseSuffix : `${baseSuffix}_${counter}`
    const maxBaseBytes = PG_IDENTIFIER_MAX_BYTES - Buffer.byteLength(suffix)
    if (maxBaseBytes <= 0) {
      throw new Error(`Unable to generate safe column name for ${name}: suffix too long`)
    }
    const base = truncateIdentifier(name, maxBaseBytes)
    const candidate = `${base}${suffix}`
    if (!used.has(candidate)) {
      return candidate
    }
  }

  throw new Error(`Unable to generate unique column name for ${name}`)
}

function buildSigmaGeneratedColumnNameMap(
  columnNames: string[],
  reserved: Set<string>
): Map<string, string> {
  const used = new Set<string>()
  for (const name of reserved) {
    used.add(truncateIdentifier(name, PG_IDENTIFIER_MAX_BYTES))
  }
  const map = new Map<string, string>()
  for (const name of columnNames) {
    const safeName = ensureUniqueIdentifier(name, used)
    map.set(name, safeName)
    used.add(safeName)
  }
  return map
}

function getSigmaColumnMappings(config: SigmaIngestionConfig) {
  const extraColumnNames = config.upsert.extraColumns?.map((c) => c.column) ?? []
  const extraColumnSet = new Set(extraColumnNames)
  const generatedColumns = (config.columns ?? []).filter((c) => !extraColumnSet.has(c.name))
  const reserved = new Set<string>([...SIGMA_BASE_COLUMNS, ...extraColumnNames])
  const generatedNameMap = buildSigmaGeneratedColumnNameMap(
    generatedColumns.map((c) => c.name),
    reserved
  )

  return {
    extraColumnNames,
    generatedColumns,
    generatedNameMap,
  }
}

async function doesTableExist(client: Client, schema: string, tableName: string): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = $1
      AND table_name = $2
    )`,
    [schema, tableName]
  )
  return result.rows[0]?.exists || false
}

async function renameMigrationsTableIfNeeded(
  client: Client,
  schema = 'stripe',
  logger?: Logger
): Promise<void> {
  const oldTableExists = await doesTableExist(client, schema, 'migrations')
  const newTableExists = await doesTableExist(client, schema, '_migrations')

  if (oldTableExists && !newTableExists) {
    logger?.info('Renaming migrations table to _migrations')
    await client.query(`ALTER TABLE "${schema}"."migrations" RENAME TO "_migrations"`)
    logger?.info('Successfully renamed migrations table')
  }
}

async function cleanupSchema(client: Client, schema: string, logger?: Logger): Promise<void> {
  logger?.warn(`Migrations table is empty - dropping and recreating schema "${schema}"`)
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await client.query(`CREATE SCHEMA "${schema}"`)
  logger?.info(`Schema "${schema}" has been reset`)
}

async function connectAndMigrate(
  client: Client,
  migrationsDirectory: string,
  config: MigrationConfig,
  logOnError = true
) {
  if (!fs.existsSync(migrationsDirectory)) {
    throw new Error(`Migrations directory not found. ${migrationsDirectory} does not exist.`)
  }

  const optionalConfig = {
    schemaName: 'stripe',
    tableName: '_migrations',
  }

  try {
    await migrate({ client }, migrationsDirectory, optionalConfig)
  } catch (error) {
    if (logOnError && error instanceof Error) {
      config.logger?.error(error, 'Migration error:')
    }
    throw error
  }
}

async function fetchTableMetadata(client: Client, schema: string, table: string) {
  // Fetch columns
  const colsResult = await client.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2
  `,
    [schema, table]
  )

  // Fetch PK columns
  const pkResult = await client.query(
    `
    SELECT a.attname
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = $1::regclass
    AND i.indisprimary
  `,
    [`"${schema}"."${table}"`]
  )

  return {
    columns: colsResult.rows.map((r) => r.column_name),
    pk: pkResult.rows.map((r) => r.attname),
  }
}

function shouldRecreateTable(
  current: { columns: string[]; pk: string[] },
  expectedCols: string[],
  expectedPk: string[]
): boolean {
  // Compare PKs
  const pkMatch =
    current.pk.length === expectedPk.length && expectedPk.every((p) => current.pk.includes(p))
  if (!pkMatch) return true

  // Compare columns
  const allExpected = [...new Set([...SIGMA_BASE_COLUMNS, ...expectedCols])]

  if (current.columns.length !== allExpected.length) return true
  return allExpected.every((c) => current.columns.includes(c))
}

async function ensureSigmaTableMetadata(
  client: Client,
  schema: string,
  config: SigmaIngestionConfig
): Promise<void> {
  const tableName = config.destinationTable

  // 1. Foreign key to stripe.accounts
  const fkName = `fk_${tableName}_account`
  await client.query(`
    ALTER TABLE "${schema}"."${tableName}"
    DROP CONSTRAINT IF EXISTS "${fkName}";
  `)
  await client.query(`
    ALTER TABLE "${schema}"."${tableName}"
    ADD CONSTRAINT "${fkName}"
    FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
  `)

  // 2. Updated at trigger
  await client.query(`
    DROP TRIGGER IF EXISTS handle_updated_at ON "${schema}"."${tableName}";
  `)
  await client.query(`
    CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON "${schema}"."${tableName}"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `)
}

async function createSigmaTable(
  client: Client,
  schema: string,
  config: SigmaIngestionConfig
): Promise<void> {
  const tableName = config.destinationTable
  const { generatedColumns, generatedNameMap } = getSigmaColumnMappings(config)
  const pk = config.upsert.conflictTarget.map((c) => generatedNameMap.get(c) ?? c)

  const columnDefs = [
    '"_raw_data" jsonb NOT NULL',
    '"_last_synced_at" timestamptz',
    '"_updated_at" timestamptz DEFAULT now()',
    '"_account_id" text NOT NULL',
  ]

  // Explicit columns
  for (const col of config.upsert.extraColumns ?? []) {
    columnDefs.push(`"${col.column}" ${col.pgType} NOT NULL`)
  }

  // Generated columns
  for (const col of generatedColumns) {
    // For temporal types in generated columns, use text to avoid immutability errors
    const isTemporal =
      col.pgType === 'timestamptz' || col.pgType === 'date' || col.pgType === 'timestamp'
    const pgType = isTemporal ? 'text' : col.pgType
    const safeName = generatedNameMap.get(col.name) ?? col.name

    columnDefs.push(
      `"${safeName}" ${pgType} GENERATED ALWAYS AS ((NULLIF(_raw_data->>'${col.name}', ''))::${pgType}) STORED`
    )
  }

  const sql = `
    CREATE TABLE "${schema}"."${tableName}" (
      ${columnDefs.join(',\n      ')},
      PRIMARY KEY (${pk.map((c) => `"${c}"`).join(', ')})
    );
  `
  await client.query(sql)
  await ensureSigmaTableMetadata(client, schema, config)
}

async function migrateSigmaSchema(
  client: Client,
  config: MigrationConfig,
  sigmaSchemaName = 'sigma'
): Promise<void> {
  config.logger?.info(`Reconciling Sigma schema "${sigmaSchemaName}"`)

  await client.query(`CREATE SCHEMA IF NOT EXISTS "${sigmaSchemaName}"`)

  for (const [key, tableConfig] of Object.entries(SIGMA_INGESTION_CONFIGS)) {
    if (!tableConfig.columns) {
      config.logger?.info(`Skipping Sigma table ${key} - no column metadata`)
      continue
    }

    const tableName = tableConfig.destinationTable
    const tableExists = await doesTableExist(client, sigmaSchemaName, tableName)

    const { extraColumnNames, generatedColumns, generatedNameMap } =
      getSigmaColumnMappings(tableConfig)
    const expectedCols = [
      ...extraColumnNames,
      ...generatedColumns.map((c) => generatedNameMap.get(c.name) ?? c.name),
    ]
    const expectedPk = tableConfig.upsert.conflictTarget.map((c) => generatedNameMap.get(c) ?? c)

    if (tableExists) {
      const metadata = await fetchTableMetadata(client, sigmaSchemaName, tableName)
      if (shouldRecreateTable(metadata, expectedCols, expectedPk)) {
        config.logger?.warn(
          `Schema mismatch for ${sigmaSchemaName}.${tableName} - dropping and recreating`
        )
        await client.query(`DROP TABLE "${sigmaSchemaName}"."${tableName}" CASCADE`)
        await createSigmaTable(client, sigmaSchemaName, tableConfig)
      } else {
        await ensureSigmaTableMetadata(client, sigmaSchemaName, tableConfig)
      }
    } else {
      config.logger?.info(`Creating Sigma table ${sigmaSchemaName}.${tableName}`)
      await createSigmaTable(client, sigmaSchemaName, tableConfig)
    }
  }
}

export async function runMigrations(config: MigrationConfig): Promise<void> {
  // Init DB
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: config.ssl,
    connectionTimeoutMillis: 10_000,
  })

  const schema = 'stripe'

  try {
    // Run migrations
    await client.connect()

    // Ensure schema exists, not doing it via migration to not break current migration checksums
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema};`)

    // Rename old migrations table if it exists (one-time upgrade to internal table naming convention)
    await renameMigrationsTableIfNeeded(client, schema, config.logger)

    // Check if migrations table is empty and cleanup if needed
    const tableExists = await doesTableExist(client, schema, '_migrations')
    if (tableExists) {
      const migrationCount = await client.query(
        `SELECT COUNT(*) as count FROM "${schema}"."_migrations"`
      )
      const isEmpty = migrationCount.rows[0]?.count === '0'
      if (isEmpty) {
        await cleanupSchema(client, schema, config.logger)
      }
    }

    config.logger?.info('Running migrations')

    await connectAndMigrate(client, path.resolve(__dirname, './migrations'), config, true)

    // Run Sigma dynamic migrations after core migrations (only if sigma is enabled)
    if (config.enableSigma) {
      await migrateSigmaSchema(client, config)
    }
  } catch (err) {
    config.logger?.error(err, 'Error running migrations')
    throw err
  } finally {
    await client.end()
    config.logger?.info('Finished migrations')
  }
}

// Helper to parse migration ID from filename (matches pg-node-migrations behavior)
function parseMigrationId(fileName: string): number {
  const match = /^(-?\d+)[-_]?/.exec(fileName)
  if (!match) {
    throw new Error(`Invalid migration file name: '${fileName}'`)
  }
  return parseInt(match[1], 10)
}

// Helper to compute hash matching pg-node-migrations format
function computeMigrationHash(fileName: string, sql: string): string {
  return crypto
    .createHash('sha1')
    .update(fileName + sql, 'utf8')
    .digest('hex')
}

type ParsedMigration = {
  id: number
  name: string
  fileName: string
  sql: string
  hash: string
}

function parseMigrations(migrations: EmbeddedMigration[]): ParsedMigration[] {
  return migrations
    .map((m) => ({
      id: parseMigrationId(m.name),
      name: m.name.replace(/^\d+[-_]?/, '').replace(/\.sql$/, '') || m.name,
      fileName: m.name,
      sql: m.sql,
      hash: computeMigrationHash(m.name, m.sql),
    }))
    .sort((a, b) => a.id - b.id)
}

async function ensureMigrationsTable(
  client: Client,
  schema: string,
  tableName: string
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${schema}"."${tableName}" (
      id integer PRIMARY KEY,
      name varchar(100) UNIQUE NOT NULL,
      hash varchar(40) NOT NULL,
      executed_at timestamp DEFAULT current_timestamp
    )
  `)
}

async function getAppliedMigrations(
  client: Client,
  schema: string,
  tableName: string
): Promise<{ id: number; name: string; hash: string }[]> {
  const tableExists = await doesTableExist(client, schema, tableName)
  if (!tableExists) {
    return []
  }
  const result = await client.query(
    `SELECT id, name, hash FROM "${schema}"."${tableName}" ORDER BY id`
  )
  return result.rows
}

async function runMigration(
  client: Client,
  schema: string,
  tableName: string,
  migration: ParsedMigration,
  logger?: Logger
): Promise<void> {
  logger?.info(`Running migration: ${migration.id} ${migration.name}`)

  await client.query('BEGIN')
  try {
    await client.query(migration.sql)
    await client.query(
      `INSERT INTO "${schema}"."${tableName}" (id, name, hash) VALUES ($1, $2, $3)`,
      [migration.id, migration.name, migration.hash]
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

/**
 * Run migrations from embedded content (for use in edge functions without filesystem access).
 * This is compatible with pg-node-migrations table format.
 */
export async function runMigrationsFromContent(
  config: MigrationConfig,
  migrations: EmbeddedMigration[]
): Promise<void> {
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: config.ssl,
    connectionTimeoutMillis: 10_000,
  })

  const schema = 'stripe'
  const tableName = '_migrations'

  try {
    config.logger?.info('Starting migrations (from embedded content)')
    await client.connect()
    config.logger?.info('Connected to database')

    // Ensure schema exists
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema};`)

    // Rename old migrations table if it exists (one-time upgrade)
    await renameMigrationsTableIfNeeded(client, schema, config.logger)

    // Check if migrations table is empty and cleanup if needed
    const tableExists = await doesTableExist(client, schema, tableName)
    if (tableExists) {
      const migrationCount = await client.query(
        `SELECT COUNT(*) as count FROM "${schema}"."${tableName}"`
      )
      const isEmpty = migrationCount.rows[0]?.count === '0'
      if (isEmpty) {
        await cleanupSchema(client, schema, config.logger)
      }
    }

    // Ensure migrations table exists
    await ensureMigrationsTable(client, schema, tableName)

    // Get applied migrations
    const appliedMigrations = await getAppliedMigrations(client, schema, tableName)
    const appliedIds = new Set(appliedMigrations.map((m) => m.id))

    // Validate hashes of applied migrations match
    const parsedMigrations = parseMigrations(migrations)
    for (const applied of appliedMigrations) {
      const intended = parsedMigrations.find((m) => m.id === applied.id)
      if (intended && intended.hash !== applied.hash) {
        throw new Error(
          `Migration hash mismatch for ${applied.name}: ` +
            `expected ${intended.hash}, got ${applied.hash}. ` +
            `Migrations cannot be modified after being applied.`
        )
      }
    }

    // Run pending migrations
    const pendingMigrations = parsedMigrations.filter((m) => !appliedIds.has(m.id))
    if (pendingMigrations.length === 0) {
      config.logger?.info('No migrations to run')
    } else {
      config.logger?.info(`Running ${pendingMigrations.length} migration(s)`)
      for (const migration of pendingMigrations) {
        await runMigration(client, schema, tableName, migration, config.logger)
      }
      config.logger?.info(`Successfully applied ${pendingMigrations.length} migration(s)`)
    }
  } catch (err) {
    config.logger?.error(err, 'Error running migrations')
    throw err
  } finally {
    await client.end()
    config.logger?.info('Finished migrations')
  }
}
