import type pg from 'pg'
import { createLogger } from '@stripe/sync-logger'

const verbose = process.env.DANGEROUSLY_VERBOSE_LOGGING === 'true'
const STDERR_FD = 2
const logger = createLogger({ name: 'util-postgres', destination: STDERR_FD })

/**
 * Wrap a pg.Pool so every query is logged to stderr when
 * DANGEROUSLY_VERBOSE_LOGGING is enabled.
 * Format: structured log with duration, row count, and truncated SQL preview.
 */
export function withQueryLogging<T extends pg.Pool>(pool: T): T {
  if (!verbose) return pool

  const origQuery = pool.query.bind(pool) as typeof pool.query

  function extractSql(args: unknown[]): string | undefined {
    if (typeof args[0] === 'string') return args[0]
    if (args[0] && typeof args[0] === 'object' && 'text' in args[0])
      return (args[0] as { text: string }).text
    return undefined
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(pool as any).query = async function (...args: unknown[]) {
    const sql = extractSql(args)
    const sql_preview = sql?.replace(/\s+/g, ' ').slice(0, 300) ?? '(unknown)'
    const start = Date.now()
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (origQuery as any)(...args)
      logger.info(
        {
          duration_ms: Date.now() - start,
          row_count: result?.rowCount ?? 0,
          sql_preview,
        },
        'Postgres query'
      )
      return result
    } catch (err) {
      logger.error(
        {
          duration_ms: Date.now() - start,
          sql_preview,
          err,
        },
        'Postgres query failed'
      )
      throw err
    }
  }
  return pool
}
