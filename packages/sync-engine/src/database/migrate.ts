import { Client } from 'pg'
import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import { createHash } from 'node:crypto'
import type { ConnectionOptions } from 'node:tls'
import type { Logger } from '../types'
import { SIGMA_INGESTION_CONFIGS } from '../sigma/sigmaIngestionConfigs'
import type { SigmaIngestionConfig } from '../sigma/sigmaIngestion'
import {
  PostgresAdapter,
  RUNTIME_REQUIRED_TABLES,
  RUNTIME_RESOURCE_ALIASES,
  SpecParser,
  WritePathPlanner,
  resolveOpenApiSpec,
} from '../openapi'
import type { EmbeddedMigration } from './migrations-embedded'

const DEFAULT_STRIPE_API_VERSION = '2020-08-27'
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
  stripeApiVersion?: string
  openApiSpecPath?: string
  openApiCacheDir?: string
  schemaName?: string
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function rewriteStripeSchema(sql: string, schemaName: string): string {
  return sql.replaceAll('"stripe"', quoteIdentifier(schemaName))
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
async function fetchTableMetadata(client: Client, schema: string, table: string) {
  const colsResult = await client.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2
  `,
    [schema, table]
  )

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
  const pkMatch =
    current.pk.length === expectedPk.length && expectedPk.every((p) => current.pk.includes(p))
  if (!pkMatch) return true

  const allExpected = [...new Set([...SIGMA_BASE_COLUMNS, ...expectedCols])]
  if (current.columns.length !== allExpected.length) return true
  return allExpected.every((c) => current.columns.includes(c))
}

async function ensureSigmaTableMetadata(
  client: Client,
  schema: string,
  config: SigmaIngestionConfig,
  stripeSchemaName = 'stripe'
): Promise<void> {
  const tableName = config.destinationTable

  const fkName = `fk_${tableName}_account`
  const stripeSchemaIdent = quoteIdentifier(stripeSchemaName)
  await client.query(`
    ALTER TABLE "${schema}"."${tableName}"
    DROP CONSTRAINT IF EXISTS "${fkName}";
  `)
  await client.query(`
    ALTER TABLE "${schema}"."${tableName}"
    ADD CONSTRAINT "${fkName}"
    FOREIGN KEY ("_account_id") REFERENCES ${stripeSchemaIdent}."accounts" (id);
  `)

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
  config: SigmaIngestionConfig,
  stripeSchemaName = 'stripe'
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

  for (const col of config.upsert.extraColumns ?? []) {
    columnDefs.push(`"${col.column}" ${col.pgType} NOT NULL`)
  }

  for (const col of generatedColumns) {
    // Temporal casts in generated columns are not immutable in Postgres.
    const isTemporal =
      col.pgType === 'timestamptz' || col.pgType === 'date' || col.pgType === 'timestamp'
    const pgType = isTemporal ? 'text' : col.pgType
    const safeName = generatedNameMap.get(col.name) ?? col.name
    columnDefs.push(
      `"${safeName}" ${pgType} GENERATED ALWAYS AS ((NULLIF(_raw_data->>'${col.name}', ''))::${pgType}) STORED`
    )
  }

  await client.query(`
    CREATE TABLE "${schema}"."${tableName}" (
      ${columnDefs.join(',\n      ')},
      PRIMARY KEY (${pk.map((c) => `"${c}"`).join(', ')})
    );
  `)
  await ensureSigmaTableMetadata(client, schema, config, stripeSchemaName)
}

async function migrateSigmaSchema(
  client: Client,
  config: MigrationConfig,
  sigmaSchemaName = 'sigma',
  stripeSchemaName = 'stripe'
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
        await createSigmaTable(client, sigmaSchemaName, tableConfig, stripeSchemaName)
      } else {
        await ensureSigmaTableMetadata(client, sigmaSchemaName, tableConfig, stripeSchemaName)
      }
    } else {
      config.logger?.info(`Creating Sigma table ${sigmaSchemaName}.${tableName}`)
      await createSigmaTable(client, sigmaSchemaName, tableConfig, stripeSchemaName)
    }
  }
}

async function rebuildStripeSchema(
  client: Client,
  stripeSchemaName = 'stripe',
  logger?: Logger
): Promise<void> {
  const schemaIdent = quoteIdentifier(stripeSchemaName)
  logger?.info(`Dropping and recreating ${stripeSchemaName} schema`)
  await client.query(`DROP SCHEMA IF EXISTS ${schemaIdent} CASCADE`)
  await client.query(`CREATE SCHEMA ${schemaIdent}`)
}

async function bootstrapInternalSchema(client: Client, stripeSchemaName = 'stripe'): Promise<void> {
  const runQuery = (sql: string) => client.query(rewriteStripeSchema(sql, stripeSchemaName))
  await runQuery(`CREATE EXTENSION IF NOT EXISTS btree_gist`)

  await runQuery(`
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
        LANGUAGE plpgsql
    AS $$
    BEGIN
      NEW._updated_at = now();
      RETURN NEW;
    END;
    $$;
  `)

  await runQuery(`
    CREATE OR REPLACE FUNCTION set_updated_at_metadata() RETURNS trigger
        LANGUAGE plpgsql
    AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$;
  `)

  await runQuery(`
    CREATE TABLE "stripe"."_migrations" (
      id serial PRIMARY KEY,
      migration_name text NOT NULL UNIQUE,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `)
  await runQuery(`
    INSERT INTO "stripe"."_migrations" ("migration_name")
    VALUES ('openapi_bootstrap')
    ON CONFLICT ("migration_name") DO NOTHING;
  `)

  await runQuery(`
    CREATE TABLE "stripe"."accounts" (
      "_raw_data" jsonb NOT NULL,
      "id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
      "api_key_hashes" text[] NOT NULL DEFAULT '{}',
      "first_synced_at" timestamptz NOT NULL DEFAULT now(),
      "_last_synced_at" timestamptz NOT NULL DEFAULT now(),
      "_updated_at" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("id")
    );
  `)
  await runQuery(`
    CREATE INDEX "idx_accounts_api_key_hashes" ON "stripe"."accounts" USING GIN ("api_key_hashes");
  `)
  await runQuery(`DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."accounts";`)
  await runQuery(`
    CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON "stripe"."accounts"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `)

  await runQuery(`
    CREATE TABLE "stripe"."_managed_webhooks" (
      "id" text PRIMARY KEY,
      "object" text,
      "url" text NOT NULL,
      "enabled_events" jsonb NOT NULL,
      "description" text,
      "enabled" boolean,
      "livemode" boolean,
      "metadata" jsonb,
      "secret" text NOT NULL,
      "status" text,
      "api_version" text,
      "created" bigint,
      "last_synced_at" timestamptz,
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      "account_id" text NOT NULL,
      CONSTRAINT "managed_webhooks_url_account_unique" UNIQUE ("url", "account_id"),
      CONSTRAINT "fk_managed_webhooks_account"
        FOREIGN KEY ("account_id") REFERENCES "stripe"."accounts" (id)
    );
  `)
  await runQuery(`
    CREATE INDEX "idx_managed_webhooks_status" ON "stripe"."_managed_webhooks" ("status");
  `)
  await runQuery(`
    CREATE INDEX "idx_managed_webhooks_enabled" ON "stripe"."_managed_webhooks" ("enabled");
  `)
  await runQuery(`DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."_managed_webhooks";`)
  await runQuery(`
    CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON "stripe"."_managed_webhooks"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at_metadata();
  `)

  await runQuery(`
    CREATE TABLE "stripe"."_sync_runs" (
      "_account_id" text NOT NULL,
      "started_at" timestamptz NOT NULL DEFAULT now(),
      "closed_at" timestamptz,
      "max_concurrent" integer NOT NULL DEFAULT 3,
      "triggered_by" text,
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("_account_id", "started_at"),
      CONSTRAINT "fk_sync_runs_account"
        FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id)
    );
  `)
  await runQuery(`
    ALTER TABLE "stripe"."_sync_runs"
    ADD CONSTRAINT one_active_run_per_account_triggered_by
    EXCLUDE (
      "_account_id" WITH =,
      COALESCE(triggered_by, 'default') WITH =
    ) WHERE (closed_at IS NULL);
  `)
  await runQuery(`DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."_sync_runs";`)
  await runQuery(`
    CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON "stripe"."_sync_runs"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at_metadata();
  `)
  await runQuery(`
    CREATE INDEX "idx_sync_runs_account_status"
      ON "stripe"."_sync_runs" ("_account_id", "closed_at");
  `)

  await runQuery(`
    CREATE TABLE "stripe"."_sync_obj_runs" (
      "_account_id" text NOT NULL,
      "run_started_at" timestamptz NOT NULL,
      "object" text NOT NULL,
      "status" text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'complete', 'error')),
      "started_at" timestamptz,
      "completed_at" timestamptz,
      "processed_count" integer NOT NULL DEFAULT 0,
      "cursor" text,
      "page_cursor" text,
      "created_gte" integer NOT NULL DEFAULT 0,
      "created_lte" integer NOT NULL DEFAULT 0,
      "priority" integer NOT NULL DEFAULT 0,
      "error_message" text,
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("_account_id", "run_started_at", "object", "created_gte", "created_lte"),
      CONSTRAINT "fk_sync_obj_runs_parent"
        FOREIGN KEY ("_account_id", "run_started_at")
        REFERENCES "stripe"."_sync_runs" ("_account_id", "started_at")
    );
  `)
  await runQuery(`DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."_sync_obj_runs";`)
  await runQuery(`
    CREATE TRIGGER handle_updated_at
    BEFORE UPDATE ON "stripe"."_sync_obj_runs"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at_metadata();
  `)
  await runQuery(`
    CREATE INDEX "idx_sync_obj_runs_status"
      ON "stripe"."_sync_obj_runs" ("_account_id", "run_started_at", "status");
  `)
  await runQuery(`
    CREATE INDEX "idx_sync_obj_runs_priority"
      ON "stripe"."_sync_obj_runs" ("_account_id", "run_started_at", "status", "priority");
  `)

  await runQuery(`
    CREATE TABLE IF NOT EXISTS "stripe"."_rate_limits" (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      window_start TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await runQuery(`
    CREATE OR REPLACE FUNCTION "stripe".check_rate_limit(
      rate_key TEXT,
      max_requests INTEGER,
      window_seconds INTEGER
    )
    RETURNS VOID AS $$
    DECLARE
      now TIMESTAMPTZ := clock_timestamp();
      window_length INTERVAL := make_interval(secs => window_seconds);
      current_count INTEGER;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext(rate_key));

      INSERT INTO "stripe"."_rate_limits" (key, count, window_start)
      VALUES (rate_key, 1, now)
      ON CONFLICT (key) DO UPDATE
      SET count = CASE
                    WHEN "_rate_limits".window_start + window_length <= now
                      THEN 1
                      ELSE "_rate_limits".count + 1
                  END,
          window_start = CASE
                           WHEN "_rate_limits".window_start + window_length <= now
                             THEN now
                             ELSE "_rate_limits".window_start
                         END;

      SELECT count INTO current_count FROM "stripe"."_rate_limits" WHERE key = rate_key;

      IF current_count > max_requests THEN
        RAISE EXCEPTION 'Rate limit exceeded for %', rate_key;
      END IF;
    END;
    $$ LANGUAGE plpgsql;
  `)

  await runQuery(`
    CREATE VIEW "stripe"."sync_runs" AS
    SELECT
      r._account_id as account_id,
      r.started_at,
      r.closed_at,
      r.triggered_by,
      r.max_concurrent,
      COALESCE(SUM(o.processed_count), 0) as total_processed,
      COUNT(o.*) as total_objects,
      COUNT(*) FILTER (WHERE o.status = 'complete') as complete_count,
      COUNT(*) FILTER (WHERE o.status = 'error') as error_count,
      COUNT(*) FILTER (WHERE o.status = 'running') as running_count,
      COUNT(*) FILTER (WHERE o.status = 'pending') as pending_count,
      STRING_AGG(o.error_message, '; ') FILTER (WHERE o.error_message IS NOT NULL) as error_message,
      CASE
        WHEN r.closed_at IS NULL AND COUNT(*) FILTER (WHERE o.status = 'running') > 0 THEN 'running'
        WHEN r.closed_at IS NULL AND (COUNT(o.*) = 0 OR COUNT(o.*) = COUNT(*) FILTER (WHERE o.status = 'pending')) THEN 'pending'
        WHEN r.closed_at IS NULL THEN 'running'
        WHEN COUNT(*) FILTER (WHERE o.status = 'error') > 0 THEN 'error'
        ELSE 'complete'
      END as status
    FROM "stripe"."_sync_runs" r
    LEFT JOIN "stripe"."_sync_obj_runs" o
      ON o._account_id = r._account_id
      AND o.run_started_at = r.started_at
    GROUP BY r._account_id, r.started_at, r.closed_at, r.triggered_by, r.max_concurrent;
  `)
  await runQuery(`DROP FUNCTION IF EXISTS "stripe"."sync_obj_progress"(TEXT, TIMESTAMPTZ);`)
  await runQuery(`
    CREATE OR REPLACE VIEW "stripe"."sync_obj_progress" AS
    SELECT
      r."_account_id" AS account_id,
      r.run_started_at,
      r.object,
      ROUND(
        100.0 * COUNT(*) FILTER (WHERE r.status = 'complete') / NULLIF(COUNT(*), 0),
        1
      ) AS pct_complete,
      COALESCE(SUM(r.processed_count), 0) AS processed
    FROM "stripe"."_sync_obj_runs" r
    WHERE r.run_started_at = (
      SELECT MAX(s.started_at)
      FROM "stripe"."_sync_runs" s
      WHERE s."_account_id" = r."_account_id"
    )
    GROUP BY r."_account_id", r.run_started_at, r.object;
  `)
}

async function applyOpenApiSchema(
  client: Client,
  config: MigrationConfig,
  stripeSchemaName = 'stripe'
): Promise<void> {
  const apiVersion = config.stripeApiVersion ?? DEFAULT_STRIPE_API_VERSION
  const resolvedSpec = await resolveOpenApiSpec({
    apiVersion,
    openApiSpecPath: config.openApiSpecPath,
    cacheDir: config.openApiCacheDir,
  })
  config.logger?.info(
    {
      apiVersion,
      source: resolvedSpec.source,
      commitSha: resolvedSpec.commitSha,
      cachePath: resolvedSpec.cachePath,
    },
    'Resolved Stripe OpenAPI spec'
  )

  const parser = new SpecParser()
  const parsedSpec = parser.parse(resolvedSpec.spec, {
    resourceAliases: RUNTIME_RESOURCE_ALIASES,
    allowedTables: [...RUNTIME_REQUIRED_TABLES],
  })
  const adapter = new PostgresAdapter({ schemaName: stripeSchemaName })
  const statements = adapter.buildAllStatements(parsedSpec.tables)
  for (const statement of statements) {
    await client.query(statement)
  }

  const planner = new WritePathPlanner()
  const writePlans = planner.buildPlans(parsedSpec.tables)
  config.logger?.info(
    {
      tableCount: parsedSpec.tables.length,
      writePlanCount: writePlans.length,
    },
    'Applied OpenAPI-generated Stripe tables'
  )
}

export async function runMigrations(config: MigrationConfig): Promise<void> {
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: config.ssl,
    connectionTimeoutMillis: 10_000,
  })
  const stripeSchemaName = config.schemaName ?? 'stripe'

  try {
    await client.connect()
    await rebuildStripeSchema(client, stripeSchemaName, config.logger)
    await bootstrapInternalSchema(client, stripeSchemaName)
    await applyOpenApiSchema(client, config, stripeSchemaName)

    if (config.enableSigma) {
      await migrateSigmaSchema(client, config, 'sigma', stripeSchemaName)
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

  const schema = config.schemaName ?? 'stripe'
  const tableName = '_migrations'

  try {
    config.logger?.info('Starting migrations (from embedded content)')
    await client.connect()
    config.logger?.info('Connected to database')

    // Ensure schema exists
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)};`)

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
