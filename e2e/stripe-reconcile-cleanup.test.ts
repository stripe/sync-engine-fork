/**
 * Verifies the Temporal `reconcileCleanup` activity tombstones rows for
 * records hard-deleted in Stripe without a `*.deleted` event — the "missed
 * delete" path complementing stripe-delete.test.ts. Two suites (postgres,
 * google_sheets) run the production activity via `MockActivityEnvironment`.
 */
import pg from 'pg'
import Stripe from 'stripe'
import { google } from 'googleapis'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { MockActivityEnvironment } from '@temporalio/testing'
import source from '@stripe/sync-source-stripe'
import destinationPostgres from '@stripe/sync-destination-postgres'
import destinationSheets, { readSheet } from '@stripe/sync-destination-google-sheets'
import { createEngine } from '@stripe/sync-engine'
import type { ConnectorResolver } from '@stripe/sync-engine'
import { createActivities } from '@stripe/sync-service'
import type { Pipeline } from '@stripe/sync-service'
import { drain } from '@stripe/sync-protocol'
import { describeWithEnv } from './test-helpers.js'

const POSTGRES_URL =
  process.env.POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres'
const ts = new Date()
  .toISOString()
  .replace(/[-:T.Z]/g, '')
  .slice(0, 15)
const CUSTOMERS_STREAM = 'customers'
const PRODUCTS_STREAM = 'products'
const BACKFILL_LIMIT = 10

function memoryPipelineStore() {
  const data = new Map<string, Pipeline>()
  return {
    async get(id: string) {
      const p = data.get(id)
      if (!p) throw new Error(`Pipeline not found: ${id}`)
      return p
    },
    async set(id: string, pipeline: Pipeline) {
      data.set(id, pipeline)
    },
    async update(id: string, patch: Partial<Omit<Pipeline, 'id'>>) {
      const existing = data.get(id)
      if (!existing) throw new Error(`Pipeline not found: ${id}`)
      const updated = { ...existing, ...patch, id } as Pipeline
      data.set(id, updated)
      return updated
    },
    async delete(id: string) {
      data.delete(id)
    },
    async list() {
      return [...data.values()]
    },
  }
}

describeWithEnv(
  'temporal reconcile-cleanup activity → postgres (missed delete)',
  ['STRIPE_API_KEY'],
  ({ STRIPE_API_KEY }) => {
    const SCHEMA = `e2e_recon_pg_${ts}`
    const PIPELINE_ID = `pipe_recon_${ts}`
    let pool: pg.Pool
    let stripe: Stripe

    const sourceConfig = { api_key: STRIPE_API_KEY, backfill_limit: BACKFILL_LIMIT }
    const destConfig = { url: POSTGRES_URL, schema: SCHEMA, batch_size: 100 }

    const resolver: ConnectorResolver = {
      resolveSource: async (name) => {
        if (name !== 'stripe') throw new Error(`Unknown source: ${name}`)
        return source
      },
      resolveDestination: async (name) => {
        if (name !== 'postgres') throw new Error(`Unknown destination: ${name}`)
        return destinationPostgres
      },
      sources: () => new Map(),
      destinations: () => new Map(),
    }

    function makePipeline() {
      return {
        source: { type: 'stripe', stripe: sourceConfig },
        destination: { type: 'postgres', postgres: destConfig },
        streams: [{ name: CUSTOMERS_STREAM }, { name: PRODUCTS_STREAM }],
      }
    }

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: POSTGRES_URL })
      await pool.query('SELECT 1')
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
      stripe = new Stripe(STRIPE_API_KEY)
      const account = await stripe.accounts.retrieve()
      console.log(`\n  Postgres:       ${POSTGRES_URL} (schema: ${SCHEMA})`)
      console.log(`  Stripe account: ${account.id}`)
      console.log(`  Pipeline:       ${PIPELINE_ID}`)
    })

    afterAll(async () => {
      if (!pool) return
      if (!process.env.KEEP_TEST_DATA) {
        await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
      }
      await pool.end()
    })

    it('tombstones deleted customers and products', async () => {
      const engine = await createEngine(resolver)
      const pipeline = makePipeline()
      const pipelineStore = memoryPipelineStore()
      await pipelineStore.set(PIPELINE_ID, { id: PIPELINE_ID, ...pipeline } as Pipeline)

      await drain(engine.pipeline_setup(pipeline))

      const survivor = await stripe.customers.create({
        name: `e2e-recon-survivor-${Date.now()}`,
      })
      const doomed = await stripe.customers.create({
        name: `e2e-recon-doomed-${Date.now()}`,
      })
      const productSurvivor = await stripe.products.create({
        name: `e2e-recon-product-survivor-${Date.now()}`,
      })
      const productDoomed = await stripe.products.create({
        name: `e2e-recon-product-doomed-${Date.now()}`,
      })
      const cleanupCustomerIds = new Set<string>([survivor.id, doomed.id])
      const cleanupProductIds = new Set<string>([productSurvivor.id, productDoomed.id])

      try {
        // Backfill-only sync (no websocket, no event polling) — all rows
        // land in postgres with `_last_synced_at ≈ T0`.
        await drain(engine.pipeline_sync(pipeline))

        const seeded = await pool.query<{ id: string }>(
          `SELECT id FROM "${SCHEMA}"."${CUSTOMERS_STREAM}" WHERE id = ANY($1)`,
          [[survivor.id, doomed.id]]
        )
        expect(new Set(seeded.rows.map((r) => r.id))).toEqual(new Set([survivor.id, doomed.id]))
        const seededProducts = await pool.query<{ id: string }>(
          `SELECT id FROM "${SCHEMA}"."${PRODUCTS_STREAM}" WHERE id = ANY($1)`,
          [[productSurvivor.id, productDoomed.id]]
        )
        expect(new Set(seededProducts.rows.map((r) => r.id))).toEqual(
          new Set([productSurvivor.id, productDoomed.id])
        )

        // Hard-delete one object per stream WITHOUT replaying the *.deleted
        // event — this is the "missed delete" reconcile-cleanup catches.
        await stripe.customers.del(doomed.id)
        cleanupCustomerIds.delete(doomed.id)
        await stripe.products.del(productDoomed.id)
        cleanupProductIds.delete(productDoomed.id)

        // `_last_synced_at` is set with millisecond precision by the destination,
        // so a small forward skew guarantees `syncRunStartedAt > _last_synced_at`.
        await new Promise((r) => setTimeout(r, 50))
        const syncRunStartedAt = new Date().toISOString()

        // engineUrl is unused by reconcileCleanup (it instantiates connectors
        // in-process); other activities in the bundle don't run here.
        const activities = createActivities({ engineUrl: 'http://unused', pipelineStore })

        const env = new MockActivityEnvironment()
        await env.run(activities.reconcileCleanup, PIPELINE_ID, syncRunStartedAt)

        const after = await pool.query<{ id: string }>(
          `SELECT id FROM "${SCHEMA}"."${CUSTOMERS_STREAM}" WHERE id = ANY($1)`,
          [[survivor.id, doomed.id]]
        )
        const remaining = new Set(after.rows.map((r) => r.id))
        expect(remaining.has(survivor.id), `survivor ${survivor.id} was tombstoned`).toBe(true)
        expect(remaining.has(doomed.id), `doomed ${doomed.id} was not tombstoned`).toBe(false)

        const afterProducts = await pool.query<{ id: string }>(
          `SELECT id FROM "${SCHEMA}"."${PRODUCTS_STREAM}" WHERE id = ANY($1)`,
          [[productSurvivor.id, productDoomed.id]]
        )
        const remainingProducts = new Set(afterProducts.rows.map((r) => r.id))
        expect(
          remainingProducts.has(productSurvivor.id),
          `product survivor ${productSurvivor.id} was tombstoned`
        ).toBe(true)
        expect(
          remainingProducts.has(productDoomed.id),
          `product doomed ${productDoomed.id} was not tombstoned`
        ).toBe(false)

        console.log(`    Customer survived:   ${survivor.id}`)
        console.log(`    Customer tombstoned: ${doomed.id}`)
        console.log(`    Product survived:    ${productSurvivor.id}`)
        console.log(`    Product tombstoned:  ${productDoomed.id}`)
      } finally {
        if (!process.env.KEEP_TEST_DATA) {
          for (const id of cleanupCustomerIds) {
            try {
              await stripe.customers.del(id)
            } catch {}
          }
          for (const id of cleanupProductIds) {
            try {
              await stripe.products.del(id)
            } catch {}
          }
        }
      }
    }, 180_000)
  }
)

// MARK: - Google Sheets

describeWithEnv(
  'temporal reconcile-cleanup activity → google sheets (missed delete)',
  ['STRIPE_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
  ({ STRIPE_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN }) => {
    const PIPELINE_ID = `pipe_recon_sheets_${ts}`
    let stripe: Stripe
    let sheetsClient: ReturnType<typeof google.sheets>
    let driveClient: ReturnType<typeof google.drive>
    let spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID ?? ''
    let createdSpreadsheetHere = false

    const sourceConfig = { api_key: STRIPE_API_KEY, backfill_limit: BACKFILL_LIMIT }

    const resolver: ConnectorResolver = {
      resolveSource: async (name) => {
        if (name !== 'stripe') throw new Error(`Unknown source: ${name}`)
        return source
      },
      resolveDestination: async (name) => {
        if (name !== 'google_sheets') throw new Error(`Unknown destination: ${name}`)
        return destinationSheets
      },
      sources: () => new Map(),
      destinations: () => new Map(),
    }

    function makePipeline() {
      return {
        source: { type: 'stripe', stripe: sourceConfig },
        destination: {
          type: 'google_sheets',
          google_sheets: {
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            refresh_token: GOOGLE_REFRESH_TOKEN,
            ...(spreadsheetId ? { spreadsheet_id: spreadsheetId } : {}),
            spreadsheet_title: `e2e-recon-sheets-${ts}`,
            batch_size: 50,
          },
        },
        streams: [{ name: CUSTOMERS_STREAM }, { name: PRODUCTS_STREAM }],
      }
    }

    beforeAll(async () => {
      stripe = new Stripe(STRIPE_API_KEY)
      const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
      auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN })
      sheetsClient = google.sheets({ version: 'v4', auth })
      driveClient = google.drive({ version: 'v3', auth })
    })

    afterAll(async () => {
      if (createdSpreadsheetHere && spreadsheetId && !process.env.KEEP_TEST_DATA) {
        try {
          await driveClient.files.delete({ fileId: spreadsheetId })
        } catch {}
      }
    })

    it('tombstones deleted customers and products', async () => {
      const engine = await createEngine(resolver)

      // pipeline_setup creates the spreadsheet if needed and emits the new
      // id via destination_config — capture so the second pipeline run reuses it.
      for await (const m of engine.pipeline_setup(makePipeline())) {
        if (
          m.type === 'control' &&
          m.control.control_type === 'destination_config' &&
          typeof m.control.destination_config.spreadsheet_id === 'string' &&
          m.control.destination_config.spreadsheet_id !== spreadsheetId
        ) {
          spreadsheetId = m.control.destination_config.spreadsheet_id
          createdSpreadsheetHere = true
        }
      }
      expect(spreadsheetId, 'no spreadsheet_id available (env or destination)').toBeTruthy()
      console.log(`\n  Sheets:         https://docs.google.com/spreadsheets/d/${spreadsheetId}/`)
      console.log(`  Pipeline:       ${PIPELINE_ID}`)

      const pipeline = makePipeline()
      const pipelineStore = memoryPipelineStore()
      await pipelineStore.set(PIPELINE_ID, { id: PIPELINE_ID, ...pipeline } as Pipeline)

      const survivor = await stripe.customers.create({
        name: `e2e-recon-sheets-survivor-${Date.now()}`,
      })
      const doomed = await stripe.customers.create({
        name: `e2e-recon-sheets-doomed-${Date.now()}`,
      })
      const productSurvivor = await stripe.products.create({
        name: `e2e-recon-sheets-product-survivor-${Date.now()}`,
      })
      const productDoomed = await stripe.products.create({
        name: `e2e-recon-sheets-product-doomed-${Date.now()}`,
      })
      const cleanupCustomerIds = new Set<string>([survivor.id, doomed.id])
      const cleanupProductIds = new Set<string>([productSurvivor.id, productDoomed.id])

      try {
        // Backfill seeds both streams with `_last_synced_at ≈ T0`.
        await drain(engine.pipeline_sync(pipeline))

        const seededRows = await readSheet(sheetsClient, spreadsheetId, CUSTOMERS_STREAM)
        const seededHeader = (seededRows[0] ?? []) as string[]
        const idIdx = seededHeader.indexOf('id')
        expect(idIdx, 'id column missing in sheet header').toBeGreaterThanOrEqual(0)
        const seededIds = new Set(seededRows.slice(1).map((row) => String(row[idIdx] ?? '')))
        expect(seededIds.has(survivor.id)).toBe(true)
        expect(seededIds.has(doomed.id)).toBe(true)

        const seededProducts = await readSheet(sheetsClient, spreadsheetId, PRODUCTS_STREAM)
        const seededProductHeader = (seededProducts[0] ?? []) as string[]
        const productIdIdx = seededProductHeader.indexOf('id')
        expect(productIdIdx, 'id column missing in products header').toBeGreaterThanOrEqual(0)
        const seededProductIds = new Set(
          seededProducts.slice(1).map((row) => String(row[productIdIdx] ?? ''))
        )
        expect(seededProductIds.has(productSurvivor.id)).toBe(true)
        expect(seededProductIds.has(productDoomed.id)).toBe(true)

        await stripe.customers.del(doomed.id)
        cleanupCustomerIds.delete(doomed.id)
        await stripe.products.del(productDoomed.id)
        cleanupProductIds.delete(productDoomed.id)

        await new Promise((r) => setTimeout(r, 50))
        const syncRunStartedAt = new Date().toISOString()

        const activities = createActivities({ engineUrl: 'http://unused', pipelineStore })
        const env = new MockActivityEnvironment()
        await env.run(activities.reconcileCleanup, PIPELINE_ID, syncRunStartedAt)

        const afterRows = await readSheet(sheetsClient, spreadsheetId, CUSTOMERS_STREAM)
        const afterIds = new Set(afterRows.slice(1).map((row) => String(row[idIdx] ?? '')))
        expect(afterIds.has(survivor.id), `survivor ${survivor.id} was tombstoned`).toBe(true)
        expect(afterIds.has(doomed.id), `doomed ${doomed.id} was not tombstoned`).toBe(false)

        const afterProducts = await readSheet(sheetsClient, spreadsheetId, PRODUCTS_STREAM)
        const afterProductIds = new Set(
          afterProducts.slice(1).map((row) => String(row[productIdIdx] ?? ''))
        )
        expect(
          afterProductIds.has(productSurvivor.id),
          `product survivor ${productSurvivor.id} was tombstoned`
        ).toBe(true)
        expect(
          afterProductIds.has(productDoomed.id),
          `product doomed ${productDoomed.id} was not tombstoned`
        ).toBe(false)

        console.log(`    Customer survived:   ${survivor.id}`)
        console.log(`    Customer tombstoned: ${doomed.id}`)
        console.log(`    Product survived:    ${productSurvivor.id}`)
        console.log(`    Product tombstoned:  ${productDoomed.id}`)
      } finally {
        if (!process.env.KEEP_TEST_DATA) {
          for (const id of cleanupCustomerIds) {
            try {
              await stripe.customers.del(id)
            } catch {}
          }
          for (const id of cleanupProductIds) {
            try {
              await stripe.products.del(id)
            } catch {}
          }
        }
      }
    }, 240_000)
  }
)
