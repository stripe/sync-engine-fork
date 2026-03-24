import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgresClient } from '../../database/postgres'
import { setupTestDatabase, type TestDatabase } from '../testSetup'

describe('waitForRateLimit', () => {
  let client: PostgresClient
  let db: TestDatabase

  beforeAll(async () => {
    db = await setupTestDatabase()
    client = new PostgresClient({
      schema: 'stripe',
      poolConfig: { connectionString: db.databaseUrl },
    })
  })

  afterAll(async () => {
    if (client) await client.pool.end()
    if (db) await db.close()
  })

  it('rate-limited loop vs unlimited loop for 5 seconds each', async () => {
    const duration = 5_000
    const maxRate = 50

    await client.query('DELETE FROM stripe._rate_limits')
    let rateLimitedCount = 0
    const rlStart = Date.now()
    while (Date.now() - rlStart < duration) {
      await client.waitForRateLimit(maxRate)
      rateLimitedCount++
    }

    const expected = maxRate * (duration / 1000)

    expect(rateLimitedCount).toBeGreaterThanOrEqual(expected * 0.98)
    expect(rateLimitedCount).toBeLessThanOrEqual(expected * 1.02)
  })
})
