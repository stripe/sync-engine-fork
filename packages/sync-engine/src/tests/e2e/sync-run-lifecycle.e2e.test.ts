/**
 * Sync Run Lifecycle E2E Test
 * Verifies sync_runs view and _sync_runs table stay in sync
 * Tests that object runs are created upfront to prevent premature close
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'child_process'
import pg from 'pg'
import { startPostgresContainer, checkEnvVars, type PostgresContainer } from '../testSetup'
import { StripeSync, getTableName } from '../../index.js'

describe('Sync Run Lifecycle E2E', () => {
  let pool: pg.Pool
  let container: PostgresContainer
  let sync: StripeSync
  const cwd = process.cwd()

  beforeAll(async () => {
    checkEnvVars('STRIPE_API_KEY')

    container = await startPostgresContainer()
    pool = new pg.Pool({ connectionString: container.databaseUrl })

    execSync('node dist/cli/index.js migrate', {
      cwd,
      env: { ...process.env, DATABASE_URL: container.databaseUrl },
      stdio: 'pipe',
    })

    sync = await StripeSync.create({
      databaseUrl: container.databaseUrl,
      stripeSecretKey: process.env.STRIPE_API_KEY!,
    })
  }, 60000)

  afterAll(async () => {
    await sync?.postgresClient?.pool?.end()
    await pool?.end()
    await container?.stop()
  }, 30000)

  function getResourceNames(): string[] {
    const objects = sync.getSupportedSyncObjects()
    return objects.map((obj) => getTableName(obj, sync.resourceRegistry))
  }

  it('should create object runs upfront (prevents premature close)', async () => {
    const resourceNames = getResourceNames()

    const runKey = await sync.postgresClient.joinOrCreateSyncRun(
      sync.accountId,
      'test',
      resourceNames
    )

    const result = await sync.postgresClient.pool.query(
      `SELECT COUNT(*) as count FROM stripe._sync_obj_runs
       WHERE "_account_id" = $1 AND run_started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    )
    const objectRunCount = parseInt(result.rows[0].count, 10)

    expect(objectRunCount).toBe(resourceNames.length)
  })

  it('should match sync_runs view with _sync_runs table', async () => {
    const resourceNames = getResourceNames()
    const runKey = await sync.postgresClient.joinOrCreateSyncRun(
      sync.accountId,
      'test-view-sync',
      resourceNames
    )

    const activeRun = await sync.postgresClient.getActiveSyncRun(runKey.accountId)
    expect(activeRun).not.toBeNull()
    const timeDiff = Math.abs(activeRun!.runStartedAt.getTime() - runKey.runStartedAt.getTime())
    expect(timeDiff).toBeLessThanOrEqual(100)

    const viewResult = await sync.postgresClient.pool.query(
      `SELECT closed_at, status, total_objects FROM stripe.sync_runs
       WHERE account_id = $1 AND started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    )
    const tableResult = await sync.postgresClient.pool.query(
      `SELECT closed_at FROM stripe._sync_runs
       WHERE "_account_id" = $1 AND started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    )

    const viewData = viewResult.rows[0]
    const tableData = tableResult.rows[0]

    expect(viewData.closed_at === null).toBe(tableData.closed_at === null)
  })

  it('should keep run open after first object completes (no premature close)', async () => {
    const resourceNames = getResourceNames()
    expect(resourceNames.length).toBeGreaterThan(1)

    const runKey = await sync.postgresClient.joinOrCreateSyncRun(
      sync.accountId,
      'test-premature-close',
      resourceNames
    )

    await sync.postgresClient.tryStartObjectSync(
      runKey.accountId,
      runKey.runStartedAt,
      resourceNames[0]
    )
    await sync.postgresClient.completeObjectSync(
      runKey.accountId,
      runKey.runStartedAt,
      resourceNames[0]
    )

    const afterFirstResult = await sync.postgresClient.pool.query(
      `SELECT closed_at, complete_count, total_objects, pending_count FROM stripe.sync_runs
       WHERE account_id = $1 AND started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    )
    const afterFirst = afterFirstResult.rows[0]

    const completeCount = parseInt(afterFirst.complete_count, 10)
    const totalObjects = parseInt(afterFirst.total_objects, 10)

    expect(completeCount).toBe(1)
    expect(totalObjects).toBe(resourceNames.length)
    expect(afterFirst.closed_at).toBeNull()
  })

  it('should close run properly after all objects complete', async () => {
    const resourceNames = getResourceNames()
    const runKey = await sync.postgresClient.joinOrCreateSyncRun(
      sync.accountId,
      'test-complete',
      resourceNames
    )

    for (const obj of resourceNames) {
      await sync.postgresClient.tryStartObjectSync(runKey.accountId, runKey.runStartedAt, obj)
      await sync.postgresClient.completeObjectSync(runKey.accountId, runKey.runStartedAt, obj)
    }

    const finalResult = await sync.postgresClient.pool.query(
      `SELECT closed_at, status, complete_count, total_objects, pending_count FROM stripe.sync_runs
       WHERE account_id = $1 AND started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    )
    const finalState = finalResult.rows[0]

    const finalCompleteCount = parseInt(finalState.complete_count, 10)
    const finalPendingCount = parseInt(finalState.pending_count, 10)

    expect(finalState.closed_at).not.toBeNull()
    expect(finalState.status).toBe('complete')
    expect(finalCompleteCount).toBe(resourceNames.length)
    expect(finalPendingCount).toBe(0)

    const tableResult = await sync.postgresClient.pool.query(
      `SELECT closed_at FROM stripe._sync_runs
       WHERE "_account_id" = $1 AND started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    )
    expect(tableResult.rows[0].closed_at).not.toBeNull()
  })

  it('should isolate multiple runs without interference', async () => {
    const resourceNames = getResourceNames()

    const runKey1 = await sync.postgresClient.joinOrCreateSyncRun(
      sync.accountId,
      'test-isolation-1',
      resourceNames
    )

    for (const obj of resourceNames) {
      await sync.postgresClient.tryStartObjectSync(runKey1.accountId, runKey1.runStartedAt, obj)
      await sync.postgresClient.completeObjectSync(runKey1.accountId, runKey1.runStartedAt, obj)
    }

    const runKey2 = await sync.postgresClient.joinOrCreateSyncRun(
      sync.accountId,
      'test-isolation-2',
      resourceNames
    )

    expect(runKey2.runStartedAt.getTime()).not.toBe(runKey1.runStartedAt.getTime())

    const run2ObjectsResult = await sync.postgresClient.pool.query(
      `SELECT COUNT(*) as count FROM stripe._sync_obj_runs
       WHERE "_account_id" = $1 AND run_started_at = $2`,
      [runKey2.accountId, runKey2.runStartedAt]
    )
    expect(parseInt(run2ObjectsResult.rows[0].count, 10)).toBe(resourceNames.length)

    const run1Check = await sync.postgresClient.pool.query(
      `SELECT closed_at, status FROM stripe.sync_runs
       WHERE account_id = $1 AND started_at = $2`,
      [runKey1.accountId, runKey1.runStartedAt]
    )
    expect(run1Check.rows[0].closed_at).not.toBeNull()
    expect(run1Check.rows[0].status).toBe('complete')

    const allRunsResult = await sync.postgresClient.pool.query(
      `SELECT account_id, started_at, status FROM stripe.sync_runs
       WHERE account_id = $1
       ORDER BY started_at`,
      [runKey1.accountId]
    )
    expect(allRunsResult.rows.length).toBeGreaterThanOrEqual(2)
  })
})
