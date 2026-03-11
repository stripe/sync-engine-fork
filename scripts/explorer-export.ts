#!/usr/bin/env tsx
/**
 * Export Schema Explorer Database to PGlite Bootstrap SQL
 *
 * This script:
 * 1. Reads connection details from .tmp/schema-explorer-run.json
 * 2. Connects to the harness Postgres database
 * 3. Queries information_schema to discover all tables in the 'stripe' schema
 * 4. For each table, exports CREATE TABLE DDL and INSERT statements with actual data
 * 5. Writes the result to packages/dashboard/public/explorer-data/bootstrap.sql
 * 6. Generates a fresh manifest.json with metadata
 *
 * Usage:
 *   pnpm explorer:export
 */

import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const TMP_DIR = path.join(process.cwd(), '.tmp');
const METADATA_FILE = path.join(TMP_DIR, 'schema-explorer-run.json');
const OUTPUT_DIR = path.join(process.cwd(), 'packages/dashboard/public/explorer-data');
const BOOTSTRAP_FILE = path.join(OUTPUT_DIR, 'bootstrap.sql');
const MANIFEST_FILE = path.join(OUTPUT_DIR, 'manifest.json');

// Core tables that receive special attention in manifest
const CORE_TABLES = [
  'accounts',
  'products',
  'prices',
  'customers',
  'payment_methods',
  'setup_intents',
  'subscriptions',
  'subscription_items',
  'invoices',
  'payment_intents',
  'charges',
  'refunds',
  'checkout_sessions',
  'credit_notes',
  'disputes',
  'tax_ids',
];

interface ContainerMetadata {
  databaseUrl: string;
  containerId: string;
  containerName: string;
  port: number;
  volumeName: string;
  createdAt: string;
}

interface TableInfo {
  tableName: string;
  columns: Array<{
    name: string;
    type: string;
    isNullable: boolean;
    defaultValue: string | null;
  }>;
}

interface ManifestData {
  timestamp: string;
  seed: number;
  apiVersion: string;
  totalTables: number;
  coreTables: string[];
  longTailTables: string[];
  manifest: Record<string, number>;
  failedTables: string[];
  verification: {
    allTablesSeeded: boolean;
    tablesWithData: number;
    emptyTables: string[];
  };
}

/**
 * Get all table names in the stripe schema
 */
async function getAllTables(client: Client): Promise<string[]> {
  const result = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'stripe'
      AND table_type = 'BASE TABLE'
      AND table_name NOT LIKE '\\_%'  -- Exclude internal tables starting with _
    ORDER BY table_name
  `);

  return result.rows.map((row) => row.table_name);
}

/**
 * Get detailed column information for a table
 */
async function getTableInfo(client: Client, tableName: string): Promise<TableInfo> {
  const result = await client.query(
    `
    SELECT
      column_name,
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = 'stripe'
      AND table_name = $1
    ORDER BY ordinal_position
  `,
    [tableName]
  );

  return {
    tableName,
    columns: result.rows.map((row) => ({
      name: row.column_name,
      type: row.data_type,
      isNullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
    })),
  };
}

/**
 * Generate CREATE TABLE DDL from table info
 */
function generateCreateTableDDL(tableInfo: TableInfo): string {
  const { tableName, columns } = tableInfo;

  const columnDefs = columns.map((col) => {
    let def = `  ${col.name} ${mapPostgresType(col.type)}`;

    if (!col.isNullable) {
      def += ' NOT NULL';
    }

    if (col.defaultValue) {
      def += ` DEFAULT ${col.defaultValue}`;
    }

    return def;
  });

  return `CREATE TABLE IF NOT EXISTS stripe.${tableName} (\n${columnDefs.join(',\n')}\n);`;
}

/**
 * Map PostgreSQL information_schema types to DDL types
 */
function mapPostgresType(type: string): string {
  // Map common information_schema type names to SQL DDL types
  const typeMap: Record<string, string> = {
    'character varying': 'text',
    bigint: 'bigint',
    boolean: 'boolean',
    'timestamp with time zone': 'timestamptz',
    'timestamp without time zone': 'timestamp',
    jsonb: 'jsonb',
    json: 'json',
    numeric: 'numeric',
    integer: 'integer',
    text: 'text',
    uuid: 'uuid',
    ARRAY: 'text[]',
  };

  return typeMap[type] || type;
}

/**
 * Generate INSERT statements for a table
 */
async function generateInsertStatements(
  client: Client,
  tableName: string,
  tableInfo: TableInfo
): Promise<string> {
  // Query all rows from the table
  const result = await client.query(`SELECT * FROM stripe.${tableName}`);

  if (result.rows.length === 0) {
    return `-- No data in stripe.${tableName}\n`;
  }

  const columns = tableInfo.columns.map((c) => c.name);
  const columnTypes = new Map(tableInfo.columns.map((c) => [c.name, c.type]));

  const inserts: string[] = [];

  for (const row of result.rows) {
    const values: string[] = [];

    for (const col of columns) {
      const value = row[col];
      const colType = columnTypes.get(col);

      if (value === null || value === undefined) {
        values.push('NULL');
      } else if (Array.isArray(value)) {
        // Handle PostgreSQL arrays
        if (value.length === 0) {
          values.push("'{}'");
        } else {
          const arrayValues = value.map((v) => {
            if (typeof v === 'string') {
              return `"${v.replace(/"/g, '\\"')}"`;
            }
            return String(v);
          });
          values.push(`'{${arrayValues.join(',')}}'`);
        }
      } else if (colType === 'timestamp with time zone' || colType === 'timestamp without time zone') {
        // Handle timestamp columns (pg returns them as Date objects or ISO strings)
        if (value instanceof Date) {
          values.push(`'${value.toISOString()}'`);
        } else {
          // Already a string (ISO format from pg)
          values.push(`'${String(value).replace(/'/g, "''")}'`);
        }
      } else if (value instanceof Date) {
        // Handle other Date/timestamp columns - must come before typeof object check
        values.push(`'${value.toISOString()}'`);
      } else if (typeof value === 'object') {
        // Handle JSON/JSONB columns
        values.push(`'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`);
      } else if (typeof value === 'boolean') {
        values.push(value ? 'true' : 'false');
      } else if (typeof value === 'number') {
        values.push(String(value));
      } else {
        // String values - escape single quotes
        values.push(`'${String(value).replace(/'/g, "''")}'`);
      }
    }

    inserts.push(
      `INSERT INTO stripe.${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')});`
    );
  }

  return inserts.join('\n');
}

/**
 * Get row count for a table
 */
async function getRowCount(client: Client, tableName: string): Promise<number> {
  const result = await client.query(`SELECT COUNT(*) as count FROM stripe.${tableName}`);
  return parseInt(result.rows[0].count, 10);
}

/**
 * Main export function
 */
async function exportDatabase(client: Client): Promise<void> {
  console.log('🔍 Discovering tables in stripe schema...\n');

  const tables = await getAllTables(client);
  console.log(`   ✓ Found ${tables.length} tables\n`);

  const sqlParts: string[] = [];
  const manifest: Record<string, number> = {};
  const emptyTables: string[] = [];

  // Header
  sqlParts.push('-- PGlite Bootstrap SQL');
  sqlParts.push('-- Generated by explorer-export.ts');
  sqlParts.push(`-- Timestamp: ${new Date().toISOString()}`);
  sqlParts.push(`-- Total Tables: ${tables.length}`);
  sqlParts.push('');
  sqlParts.push('-- Create schema');
  sqlParts.push('CREATE SCHEMA IF NOT EXISTS stripe;');
  sqlParts.push('');

  // Process each table
  for (const tableName of tables) {
    console.log(`📦 Exporting ${tableName}...`);

    // Get table structure
    const tableInfo = await getTableInfo(client, tableName);

    // Get row count
    const rowCount = await getRowCount(client, tableName);
    manifest[tableName] = rowCount;

    if (rowCount === 0) {
      emptyTables.push(tableName);
    }

    console.log(`   ✓ ${rowCount} rows`);

    // Generate CREATE TABLE
    sqlParts.push(`-- Table: ${tableName} (${rowCount} rows)`);
    sqlParts.push(generateCreateTableDDL(tableInfo));
    sqlParts.push('');

    // Generate INSERT statements
    if (rowCount > 0) {
      const inserts = await generateInsertStatements(client, tableName, tableInfo);
      sqlParts.push(inserts);
      sqlParts.push('');
    }
  }

  // Write bootstrap.sql
  console.log('\n📝 Writing bootstrap.sql...');
  const sql = sqlParts.join('\n');

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  fs.writeFileSync(BOOTSTRAP_FILE, sql);
  const sqlSizeKB = Math.round((sql.length / 1024) * 10) / 10;
  console.log(`   ✓ Written ${sqlSizeKB} KB to ${BOOTSTRAP_FILE}`);

  // Generate manifest.json
  console.log('\n📊 Generating manifest.json...');

  const coreTables = CORE_TABLES.filter((t) => tables.includes(t));
  const longTailTables = tables.filter((t) => !CORE_TABLES.includes(t));
  const tablesWithData = tables.filter((t) => manifest[t] > 0);

  // Try to read seed from .tmp/seed-manifest.json if it exists
  let seed = 42; // default
  let apiVersion = '2020-08-27'; // default
  const seedManifestPath = path.join(TMP_DIR, 'seed-manifest.json');
  if (fs.existsSync(seedManifestPath)) {
    try {
      const seedManifest = JSON.parse(fs.readFileSync(seedManifestPath, 'utf-8'));
      seed = seedManifest.seed || seed;
      apiVersion = seedManifest.apiVersion || apiVersion;
    } catch {
      // Ignore errors, use defaults
    }
  }

  const manifestData: ManifestData = {
    timestamp: new Date().toISOString(),
    seed,
    apiVersion,
    totalTables: tables.length,
    coreTables,
    longTailTables,
    manifest,
    failedTables: [],
    verification: {
      allTablesSeeded: emptyTables.length === 0,
      tablesWithData: tablesWithData.length,
      emptyTables,
    },
  };

  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifestData, null, 2));
  console.log(`   ✓ Written to ${MANIFEST_FILE}`);

  // Verification summary
  console.log('\n🔍 Export Summary:');
  console.log(`   ✓ Total tables: ${tables.length}`);
  console.log(`   ✓ Tables with data: ${tablesWithData.length}`);
  console.log(`   ✓ Core tables: ${coreTables.length}`);
  console.log(`   ✓ Long-tail tables: ${longTailTables.length}`);
  console.log(`   ✓ Total artifact size: ${sqlSizeKB} KB`);

  if (emptyTables.length > 0) {
    console.log(`\n   ⚠️  Empty tables (${emptyTables.length}):`);
    emptyTables.forEach((t) => console.log(`      - ${t}`));
  }

  // Check size budget (10MB uncompressed)
  const SIZE_BUDGET_KB = 10 * 1024;
  if (sqlSizeKB > SIZE_BUDGET_KB) {
    console.log(
      `\n   ⚠️  WARNING: Artifact size (${sqlSizeKB} KB) exceeds budget (${SIZE_BUDGET_KB} KB)`
    );
  }
}

async function main(): Promise<void> {
  console.log('🚀 Schema Explorer Export Script\n');

  // Load metadata
  if (!fs.existsSync(METADATA_FILE)) {
    console.error('❌ Error: No metadata file found');
    console.error(`   Expected: ${METADATA_FILE}`);
    console.error('\n💡 Start the harness first: pnpm explorer:db:start');
    process.exit(1);
  }

  const metadata: ContainerMetadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));

  console.log('📋 Connection details:');
  console.log(`   Database URL: ${metadata.databaseUrl}`);
  console.log(`   Container: ${metadata.containerName}`);
  console.log('');

  // Connect to database
  const client = new Client({ connectionString: metadata.databaseUrl });

  try {
    await client.connect();
    console.log('✅ Connected to database\n');

    await exportDatabase(client);

    console.log('\n✅ Export complete!');
  } catch (error) {
    console.error('\n❌ Export failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
