import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { StripeSync } from '../../stripeSync'
import { setupTestDatabase, type TestDatabase } from '../testSetup'
import type { PoolConfig } from 'pg'
import type Stripe from 'stripe'

describe('Webhook Race Condition Tests', () => {
  let stripeSync: StripeSync
  let db: TestDatabase
  const stripeApiKey = process.env.STRIPE_API_KEY

  if (!stripeApiKey) {
    console.warn('Skipping webhook concurrent tests - STRIPE_API_KEY not set')
  }

  beforeAll(async () => {
    if (!stripeApiKey) return

    db = await setupTestDatabase()

    const poolConfig: PoolConfig = {
      max: 20,
      connectionString: db.databaseUrl,
      keepAlive: true,
    }

    stripeSync = await StripeSync.create({
      databaseUrl: db.databaseUrl,
      stripeSecretKey: stripeApiKey,
      stripeApiVersion: '2020-08-27',
      poolConfig,
    })
  }, 30_000)

  afterAll(async () => {
    if (!stripeSync) return

    try {
      const webhooks = await stripeSync.webhook.listManagedWebhooks()
      const testWebhooks = webhooks.filter((w) => w.url.includes('test-race-'))

      for (const webhook of testWebhooks) {
        try {
          await stripeSync.webhook.deleteManagedWebhook(webhook.id)
        } catch (err) {
          console.warn(`Failed to delete test webhook ${webhook.id}:`, err)
        }
      }
    } catch (error) {
      console.warn('Failed to clean up test webhooks:', error)
    }

    await stripeSync.postgresClient.pool.end()
    if (db) await db.close()
  })

  beforeEach(async () => {
    if (!stripeSync) return

    const webhooks = await stripeSync.webhook.listManagedWebhooks()
    const matchingWebhooks = webhooks.filter((w) => w.url.includes('test-race-'))

    for (const webhook of matchingWebhooks) {
      try {
        await stripeSync.webhook.deleteManagedWebhook(webhook.id)
      } catch {
        // Ignore errors, webhook might already be deleted
      }
    }
  })

  describe('findOrCreateManagedWebhook - Concurrent Execution', () => {
    it.skipIf(!stripeApiKey)(
      'should handle 10 concurrent calls without creating duplicates',
      async () => {
        const uniqueUrl = `https://test-race-${Date.now()}-concurrent10.example.com/webhooks`

        const promises = Array(10)
          .fill(null)
          .map(() =>
            stripeSync.webhook.findOrCreateManagedWebhook(uniqueUrl, {
              enabled_events: ['*'],
              description: 'Test webhook for race condition test',
            })
          )

        const results = await Promise.allSettled(promises)

        const succeeded = results.filter((r) => r.status === 'fulfilled')
        expect(succeeded.length).toBe(10)

        const webhookIds = succeeded.map(
          (r) => (r as PromiseFulfilledResult<Stripe.WebhookEndpoint>).value.id
        )
        const uniqueIds = new Set(webhookIds)
        expect(uniqueIds.size).toBe(1)

        const dbWebhooks = await stripeSync.webhook.listManagedWebhooks()
        const matchingWebhooks = dbWebhooks.filter((w) => w.url === uniqueUrl)
        expect(matchingWebhooks.length).toBe(1)

        const stripeWebhooks = await stripeSync.stripe.webhookEndpoints.list({ limit: 100 })
        const matchingStripeWebhooks = stripeWebhooks.data.filter(
          (w) => w.url === uniqueUrl && w.metadata?.managed_by === 'stripe-sync'
        )
        expect(matchingStripeWebhooks.length).toBe(1)
      },
      30000
    )

    it.skipIf(!stripeApiKey)(
      'should handle concurrent calls with different URLs correctly',
      async () => {
        const timestamp = Date.now()
        const urlA = `https://test-race-${timestamp}-url-a.example.com/webhooks`
        const urlB = `https://test-race-${timestamp}-url-b.example.com/webhooks`

        const urlAPromises = Array(5)
          .fill(null)
          .map(() =>
            stripeSync.webhook.findOrCreateManagedWebhook(urlA, {
              enabled_events: ['*'],
              description: 'Test webhook A',
            })
          )

        const urlBPromises = Array(5)
          .fill(null)
          .map(() =>
            stripeSync.webhook.findOrCreateManagedWebhook(urlB, {
              enabled_events: ['*'],
              description: 'Test webhook B',
            })
          )

        const results = await Promise.allSettled([...urlAPromises, ...urlBPromises])

        const succeeded = results.filter((r) => r.status === 'fulfilled')
        expect(succeeded.length).toBe(10)

        const webhookIds = succeeded.map(
          (r) => (r as PromiseFulfilledResult<Stripe.WebhookEndpoint>).value.id
        )
        const uniqueIds = new Set(webhookIds)
        expect(uniqueIds.size).toBe(2)

        const dbWebhooks = await stripeSync.webhook.listManagedWebhooks()
        const matchingWebhooks = dbWebhooks.filter((w) => w.url === urlA || w.url === urlB)
        expect(matchingWebhooks.length).toBe(2)

        for (const id of uniqueIds) {
          await stripeSync.webhook.deleteManagedWebhook(id)
        }
      },
      30000
    )

    it.skipIf(!stripeApiKey)(
      'should reuse existing webhook when called sequentially',
      async () => {
        const uniqueUrl = `https://test-race-${Date.now()}-sequential.example.com/webhooks`

        const webhook1 = await stripeSync.webhook.findOrCreateManagedWebhook(uniqueUrl, {
          enabled_events: ['*'],
          description: 'Test webhook sequential',
        })

        const webhook2 = await stripeSync.webhook.findOrCreateManagedWebhook(uniqueUrl, {
          enabled_events: ['*'],
          description: 'Test webhook sequential',
        })

        expect(webhook1.id).toBe(webhook2.id)

        await stripeSync.webhook.deleteManagedWebhook(webhook1.id)
      },
      15000
    )
  })

  describe('Unique Constraint Tests', () => {
    it.skipIf(!stripeApiKey)(
      'should handle unique constraint violation gracefully in createManagedWebhook',
      async () => {
        const uniqueUrl = `https://test-race-${Date.now()}-unique-constraint.example.com/webhooks`

        const webhook1 = await stripeSync.webhook.findOrCreateManagedWebhook(uniqueUrl, {
          enabled_events: ['*'],
          description: 'Test webhook 1',
        })

        const webhook2Promise = await stripeSync.webhook.findOrCreateManagedWebhook(uniqueUrl, {
          enabled_events: ['*'],
          description: 'Test webhook 2',
        })

        const webhook2 = await webhook2Promise

        expect(webhook2.id).toBeTruthy()

        const dbWebhooks = await stripeSync.webhook.listManagedWebhooks()
        const matchingWebhooks = dbWebhooks.filter((w) => w.url === uniqueUrl)
        expect(matchingWebhooks.length).toBe(1)

        await stripeSync.webhook.deleteManagedWebhook(webhook1.id)
      },
      15000
    )
  })
})
