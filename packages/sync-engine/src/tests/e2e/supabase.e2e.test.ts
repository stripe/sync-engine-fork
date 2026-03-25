/**
 * Supabase E2E Tests
 *
 * Tests the consolidated stripe-sync edge function against a real Supabase project.
 *
 * Required env vars:
 *   SUPABASE_PROJECT_ID
 *   SUPABASE_PERSONAL_ACCESS_TOKEN
 *   STRIPE_API_KEY
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
// Must import from dist — the ?raw edge function bundling only works via tsup build
// Run `pnpm build` before this test (the test:e2e:supabase script does this)
import { SupabaseSetupClient } from '../../../dist/supabase/index.js'
import { checkEnvVars, getStripeClient, sleep } from '../testSetup'

const SUPABASE_REQUIRED_VARS = [
  'SUPABASE_PROJECT_ID',
  'SUPABASE_PERSONAL_ACCESS_TOKEN',
  'STRIPE_API_KEY',
] as const

describe('Supabase E2E', () => {
  let client: SupabaseSetupClient
  let stripe: ReturnType<typeof getStripeClient>

  beforeAll(async () => {
    checkEnvVars(...SUPABASE_REQUIRED_VARS)

    client = new SupabaseSetupClient({
      accessToken: process.env.SUPABASE_PERSONAL_ACCESS_TOKEN!,
      projectRef: process.env.SUPABASE_PROJECT_ID!,
    })
    stripe = getStripeClient()

    // Ensure clean slate
    try {
      const installed = await client.isInstalled()
      if (installed) {
        await client.uninstall()
        await sleep(5000)
      }
    } catch {
      try {
        await client.uninstall()
      } catch {}
      await sleep(5000)
    }
  })

  afterAll(async () => {
    // Always attempt uninstall
    try {
      await client.uninstall()
    } catch {}
  })

  describe('webhook flow', () => {
    let customerId: string | undefined

    afterAll(async () => {
      // Clean up test customer
      if (customerId) {
        try {
          await stripe.customers.del(customerId)
        } catch {}
      }
    })

    it('should install without initial sync', async () => {
      await client.install(
        process.env.STRIPE_API_KEY!,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true // skipInitialSync
      )

      const installed = await client.isInstalled()
      expect(installed).toBe(true)
    })

    it('should have empty data tables after install', async () => {
      const result = (await client.runSQL(`SELECT count(*) as count FROM stripe.customers`)) as {
        count: number
      }[]
      expect(Number(result[0].count)).toBe(0)
    })

    it('should receive customer.created webhook', async () => {
      const testName = `Supabase E2E ${Date.now()}`
      const customer = await stripe.customers.create({
        name: testName,
        email: 'supabase-e2e@test.local',
      })
      customerId = customer.id

      // Poll until webhook delivers the data (up to 90s)
      let found = false
      for (let i = 0; i < 18; i++) {
        await sleep(5000)
        const result = (await client.runSQL(
          `SELECT id, name FROM stripe.customers WHERE id = '${customer.id}'`
        )) as { id: string; name: string }[]
        if (result.length > 0) {
          expect(result[0].id).toBe(customer.id)
          expect(result[0].name).toBe(testName)
          found = true
          break
        }
      }
      expect(found).toBe(true)
    })

    it('should receive customer.updated webhook', async () => {
      expect(customerId).toBeDefined()

      const updatedName = `Updated Supabase E2E ${Date.now()}`
      await stripe.customers.update(customerId!, { name: updatedName })

      // Poll until the update arrives (up to 60s)
      let found = false
      for (let i = 0; i < 12; i++) {
        await sleep(5000)
        const result = (await client.runSQL(
          `SELECT name FROM stripe.customers WHERE id = '${customerId}'`
        )) as { name: string }[]
        if (result[0]?.name === updatedName) {
          found = true
          break
        }
      }
      expect(found).toBe(true)
    })

    it('should uninstall cleanly', async () => {
      await client.uninstall()
      const installed = await client.isInstalled()
      expect(installed).toBe(false)
    })
  })

  describe('backfill with self-reinvocation', () => {
    it('should install and sync data via backfill', async () => {
      await client.install(process.env.STRIPE_API_KEY!)

      // Poll until we see data landing (up to 120s)
      // The self-reinvocation should make this continuous
      let totalProcessed = 0
      for (let i = 0; i < 12; i++) {
        await sleep(10000)
        const runsView = (await client.runSQL(
          `SELECT total_processed, complete_count, total_objects, status FROM stripe.sync_runs LIMIT 1`
        )) as {
          total_processed: string
          complete_count: string
          total_objects: string
          status: string
        }[]

        const run = runsView[0]
        if (!run) continue

        totalProcessed = Number(run.total_processed)
        console.log(
          `  backfill progress: ${run.complete_count}/${run.total_objects} objects, ${totalProcessed} processed (${run.status})`
        )

        // We don't need to wait for completion — just verify data is landing
        if (totalProcessed > 100) break
      }

      expect(totalProcessed).toBeGreaterThan(100)

      // Verify at least one data table has rows
      const counts: Record<string, number> = {}
      for (const table of ['products', 'customers', 'coupons', 'prices']) {
        try {
          const result = (await client.runSQL(`SELECT count(*) as count FROM stripe.${table}`)) as {
            count: number
          }[]
          counts[table] = Number(result[0].count)
        } catch {}
      }
      console.log('  table counts:', counts)

      const totalRows = Object.values(counts).reduce((a, b) => a + b, 0)
      expect(totalRows).toBeGreaterThan(0)
    })

    it('should uninstall cleanly after backfill', async () => {
      await client.uninstall()
      const installed = await client.isInstalled()
      expect(installed).toBe(false)
    })
  })
})
