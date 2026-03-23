import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SpecParser, OPENAPI_RESOURCE_TABLE_ALIASES, resolveOpenApiSpec } from '../../openapi'
import { setupTestDatabase, type TestDatabase } from '../testSetup'

/** Must match `DEFAULT_STRIPE_API_VERSION` in `database/migrate.ts` (used when `runMigrations` has no `stripeApiVersion`). */
const MIGRATE_DEFAULT_STRIPE_API_VERSION = '2026-02-25.clover' as const

describe('Postgres schema vs OpenAPI resource tables', () => {
  let db: TestDatabase

  beforeAll(async () => {
    db = await setupTestDatabase()
  })

  afterAll(async () => {
    await db.close()
  })

  it('creates a base table in stripe for every resource table from the resolved OpenAPI spec', async () => {
    const resolved = await resolveOpenApiSpec({
      apiVersion: MIGRATE_DEFAULT_STRIPE_API_VERSION,
    })
    const parser = new SpecParser()
    const parsed = parser.parse(resolved.spec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })

    const expectedTableNames = parsed.tables.map((t) => t.tableName)
    console.log(expectedTableNames.length)
    expect(expectedTableNames.length).toBe(112)
    console.log(expectedTableNames)

    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'stripe'
         AND table_type = 'BASE TABLE'`
    )
    const existing = new Set(rows.map((r) => r.table_name))

    const missing = expectedTableNames.filter((name) => !existing.has(name))
    expect(
      missing,
      `Postgres is missing ${missing.length} OpenAPI table(s): ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''}`
    ).toEqual([])
  })
})
