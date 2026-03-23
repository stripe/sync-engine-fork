/**
 * E2E: sync Stripe objects using the StripeSync API directly.
 *
 * Requires `STRIPE_API_KEY` and Docker.
 * Default `vitest` excludes `*.e2e.test.ts`; run with the e2e config, e.g.
 * `pnpm test:e2e:stripe-api-objects` or
 * `pnpm exec vitest run --config vitest.e2e.config.ts src/tests/e2e/stripeApiObjects.e2e.test.ts`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  setupTestDatabase,
  queryDb,
  queryDbSingle,
  queryDbCount,
  checkEnvVars,
  type TestDatabase,
} from '../testSetup'
import { StripeSync } from '../../index.js'

describe('Stripe API objects — sync E2E', () => {
  let db: TestDatabase
  let sync: StripeSync

  beforeAll(async () => {
    checkEnvVars('STRIPE_API_KEY')
    db = await setupTestDatabase()
    sync = await StripeSync.create({
      databaseUrl: db.databaseUrl,
      stripeSecretKey: process.env.STRIPE_API_KEY!,
    })
  }, 120000)

  afterAll(async () => {
    await sync?.close()
    await db?.close()
  }, 30000)

  it('syncs customers and products successfully', async () => {
    const result = await sync.fullSync(['customers', 'products'], true, 5, 20, false, 0)

    expect(result.errors).toHaveLength(0)
    expect(result.totalSynced).toBeGreaterThan(0)

    const accountId = sync.accountId

    const customerCount = await queryDbCount(
      db.pool,
      'SELECT COUNT(*) AS count FROM stripe.customers WHERE _account_id = $1',
      [accountId]
    )
    expect(customerCount).toBeGreaterThan(0)

    const productCount = await queryDbCount(
      db.pool,
      'SELECT COUNT(*) AS count FROM stripe.products WHERE _account_id = $1',
      [accountId]
    )
    expect(productCount).toBeGreaterThan(0)
  }, 300000)

  it('completes a full sync with every object run successful', async () => {
    const result = await sync.fullSync(undefined, true, 10, 20, false, 0)

    expect(result.errors).toHaveLength(0)

    const accountId = sync.accountId

    const latest = await queryDbSingle<{
      status: string
      error_count: string | number
      complete_count: string | number
      total_objects: string | number
      pending_count: string | number
      running_count: string | number
      closed_at: Date | null
    }>(
      db.pool,
      `SELECT status, error_count, complete_count, total_objects, pending_count, running_count, closed_at
       FROM stripe.sync_runs
       WHERE account_id = $1
       ORDER BY started_at DESC
       LIMIT 1`,
      [accountId]
    )

    expect(latest).not.toBeNull()
    expect(latest!.closed_at).not.toBeNull()
    expect(latest!.status).toBe('complete')
    expect(Number(latest!.error_count)).toBe(0)
    expect(Number(latest!.pending_count)).toBe(0)
    expect(Number(latest!.running_count)).toBe(0)
    expect(Number(latest!.total_objects)).toBeGreaterThan(0)
    expect(Number(latest!.complete_count)).toBe(Number(latest!.total_objects))

    const syncedNonNestedObjects = await queryDb<{ object: string }>(
      db.pool,
      `SELECT DISTINCT object FROM stripe._sync_obj_runs
       WHERE _account_id = $1
         AND run_started_at = (SELECT MAX(started_at) FROM stripe._sync_runs WHERE _account_id = $1)
         AND nested = false`,
      [accountId]
    )

    const nonNestedTableCount = await queryDbCount(
      db.pool,
      `SELECT COUNT(*) AS count FROM information_schema.tables t
       WHERE t.table_schema = 'stripe'
         AND t.table_type = 'BASE TABLE'
         AND t.table_name NOT LIKE '\\_%'
         AND t.table_name NOT IN (
           SELECT nested_table FROM stripe._sync_nested_objects
         )`
    )

    expect(syncedNonNestedObjects.length).toBe(nonNestedTableCount)
  }, 600000)
})
