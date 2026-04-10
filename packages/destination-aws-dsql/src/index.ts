import pg from 'pg'
import type { PoolConfig } from 'pg'
import { DsqlSigner } from '@aws-sdk/dsql-signer'
import type { Destination, DestinationInput, LogMessage } from '@stripe/sync-protocol'
import { sql, upsert } from '@stripe/sync-util-postgres'
import defaultSpec from './spec.js'
import type { Config } from './spec.js'

export { configSchema, type Config } from './spec.js'
export { default as pg } from 'pg'

function logMsg(message: string, level: LogMessage['log']['level'] = 'info'): LogMessage {
  return { type: 'log', log: { level, message } }
}

/** Generate a fresh DSQL IAM auth token. */
async function generateToken(endpoint: string, region: string): Promise<string> {
  const signer = new DsqlSigner({ hostname: endpoint, region })
  return signer.getDbConnectAdminAuthToken()
}

/** Build a pg PoolConfig for DSQL with rotating IAM auth tokens. */
export async function buildPoolConfig(config: Config): Promise<PoolConfig> {
  const token = await generateToken(config.endpoint, config.region)
  return {
    host: config.endpoint,
    port: 5432,
    database: 'postgres',
    user: 'admin',
    password: token,
    ssl: true,
  }
}

function createPool(poolConfig: PoolConfig): pg.Pool {
  const pool = new pg.Pool(poolConfig)
  pool.on('error', (err) => {
    console.error('DSQL destination pool error:', err)
  })
  return pool
}

/**
 * Build a CREATE TABLE IF NOT EXISTS statement for DSQL.
 *
 * DSQL does not support: triggers, generated columns, PL/pgSQL DO blocks, jsonb.
 * We store _raw_data as text (JSON-serialized) with id as primary key.
 */
function buildCreateTableSQL(schema: string, tableName: string): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`
  return sql`
    CREATE TABLE IF NOT EXISTS ${q(schema)}.${q(tableName)} (
      "id" text NOT NULL,
      "_raw_data" text NOT NULL,
      "_last_synced_at" timestamptz,
      "_updated_at" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("id")
    )
  `
}

/**
 * Upsert records into a DSQL table.
 * Explicitly sets _updated_at = now() since DSQL has no trigger support.
 */
async function upsertMany(
  pool: pg.Pool,
  schema: string,
  table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entries: Record<string, any>[]
): Promise<void> {
  if (!entries.length) return
  await upsert(
    pool,
    entries.map((e) => ({
      id: String(e.id ?? ''),
      _raw_data: JSON.stringify(e),
      _updated_at: new Date().toISOString(),
    })),
    {
      schema,
      table,
      keyColumns: ['id'],
      noDiffColumns: ['_updated_at'],
    }
  )
}

/** Check if an error looks transient. */
function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return msg.includes('econnrefused') || msg.includes('timeout') || msg.includes('connection')
}

const destination = {
  async *spec() {
    yield { type: 'spec' as const, spec: defaultSpec }
  },

  async *check({ config }) {
    const pool = createPool(await buildPoolConfig(config))
    try {
      await pool.query('SELECT 1')
      yield {
        type: 'connection_status' as const,
        connection_status: { status: 'succeeded' as const },
      }
    } catch (err) {
      yield {
        type: 'connection_status' as const,
        connection_status: {
          status: 'failed' as const,
          message: err instanceof Error ? err.message : String(err),
        },
      }
    } finally {
      await pool.end()
    }
  },

  async *setup({ config, catalog }) {
    const pool = createPool(await buildPoolConfig(config))
    try {
      yield logMsg(`Creating schema "${config.schema}" (${catalog.streams.length} streams)`)
      await pool.query(sql`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`)
      // DSQL requires sequential DDL — concurrent CREATE TABLE causes OC001 conflicts
      for (const cs of catalog.streams) {
        await pool.query(buildCreateTableSQL(config.schema, cs.stream.name))
      }
    } finally {
      await pool.end()
    }
  },

  async *teardown({ config }) {
    const PROTECTED = new Set(['public', 'information_schema', 'pg_catalog', 'pg_toast'])
    if (PROTECTED.has(config.schema)) {
      throw new Error(`Refusing to drop protected schema "${config.schema}"`)
    }
    const pool = createPool(await buildPoolConfig(config))
    try {
      await pool.query(sql`DROP SCHEMA IF EXISTS "${config.schema}" CASCADE`)
    } finally {
      await pool.end()
    }
  },

  async *write({ config }, $stdin) {
    const pool = createPool(await buildPoolConfig(config))
    const batchSize = config.batch_size
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streamBuffers = new Map<string, Record<string, any>[]>()

    const flushStream = async (streamName: string) => {
      const buffer = streamBuffers.get(streamName)
      if (!buffer || buffer.length === 0) return
      await upsertMany(pool, config.schema, streamName, buffer)
      streamBuffers.set(streamName, [])
    }

    const flushAll = async () => {
      for (const streamName of streamBuffers.keys()) {
        await flushStream(streamName)
      }
    }

    try {
      for await (const msg of $stdin as AsyncIterable<DestinationInput>) {
        if (msg.type === 'record') {
          const { stream, data } = msg.record
          if (!streamBuffers.has(stream)) streamBuffers.set(stream, [])
          const buffer = streamBuffers.get(stream)!
          buffer.push(data as Record<string, unknown>)
          if (buffer.length >= batchSize) await flushStream(stream)
        } else if (msg.type === 'source_state') {
          if (msg.source_state.state_type !== 'global') {
            await flushStream(msg.source_state.stream)
          }
          yield msg
        }
      }
      await flushAll()
    } catch (err: unknown) {
      try {
        await flushAll()
      } catch {
        // ignore flush errors during error handling
      }
      yield {
        type: 'trace' as const,
        trace: {
          trace_type: 'error' as const,
          error: {
            failure_type: isTransient(err)
              ? ('transient_error' as const)
              : ('system_error' as const),
            message: err instanceof Error ? err.message : String(err),
            stack_trace: err instanceof Error ? err.stack : undefined,
          },
        },
      }
    } finally {
      await pool.end()
    }

    yield logMsg(`DSQL destination: wrote to schema "${config.schema}"`)
  },
} satisfies Destination<Config>

export default destination
