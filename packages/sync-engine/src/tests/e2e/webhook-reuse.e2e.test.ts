/**
 * Webhook Reuse E2E Test
 * Tests that findOrCreateManagedWebhook correctly reuses existing webhooks
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import {
  startPostgresContainer,
  getStripeClient,
  checkEnvVars,
  type PostgresContainer,
} from '../testSetup'
import { StripeSync, runMigrations } from '../../index.js'

describe('Webhook Reuse E2E', () => {
  let pool: pg.Pool
  let container: PostgresContainer
  let sync: StripeSync
  const createdWebhookIds: string[] = []

  beforeAll(async () => {
    checkEnvVars('STRIPE_API_KEY')

    container = await startPostgresContainer()
    pool = new pg.Pool({ connectionString: container.databaseUrl })

    await runMigrations({ databaseUrl: container.databaseUrl })

    sync = await StripeSync.create({
      databaseUrl: container.databaseUrl,
      stripeSecretKey: process.env.STRIPE_API_KEY!,
    })
  }, 60000)

  afterAll(async () => {
    for (const id of createdWebhookIds) {
      try {
        await sync.webhook.deleteManagedWebhook(id)
      } catch {
        // Ignore errors during cleanup
      }
    }

    await sync?.postgresClient?.pool?.end()
    await pool?.end()
    await container?.stop()
  }, 30000)

  it('should create initial webhook', async () => {
    const webhook = await sync.webhook.findOrCreateManagedWebhook(
      'https://test1.example.com/stripe-webhooks',
      { enabled_events: ['*'] }
    )

    expect(webhook.id).toMatch(/^we_/)
    createdWebhookIds.push(webhook.id)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const webhooks = await (sync.webhook as any).listManagedWebhooks()
    expect(webhooks.length).toBe(1)
  })

  it('should reuse existing webhook with same base URL', async () => {
    const webhook1 = await sync.webhook.findOrCreateManagedWebhook(
      'https://test1.example.com/stripe-webhooks',
      { enabled_events: ['*'] }
    )

    const webhook2 = await sync.webhook.findOrCreateManagedWebhook(
      'https://test1.example.com/stripe-webhooks',
      { enabled_events: ['*'] }
    )

    expect(webhook2.id).toBe(webhook1.id)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const webhooks = await (sync.webhook as any).listManagedWebhooks()
    expect(webhooks.length).toBe(1)
  })

  it('should create new webhook for different base URL', async () => {
    const webhook1 = await sync.webhook.findOrCreateManagedWebhook(
      'https://test1.example.com/stripe-webhooks',
      { enabled_events: ['*'] }
    )

    const webhook2 = await sync.webhook.findOrCreateManagedWebhook(
      'https://test2.example.com/stripe-webhooks',
      { enabled_events: ['*'] }
    )
    createdWebhookIds.push(webhook2.id)

    expect(webhook2.id).not.toBe(webhook1.id)
  })

  it('should handle orphaned webhook cleanup', async () => {
    const stripe = getStripeClient()

    const webhook = await sync.webhook.findOrCreateManagedWebhook(
      'https://test3.example.com/stripe-webhooks',
      { enabled_events: ['*'] }
    )
    const orphanedId = webhook.id
    createdWebhookIds.push(orphanedId)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sync as any).postgresClient.query(`DELETE FROM stripe._managed_webhooks WHERE id = $1`, [
      orphanedId,
    ])

    const newWebhook = await sync.webhook.findOrCreateManagedWebhook(
      'https://test3.example.com/stripe-webhooks',
      { enabled_events: ['*'] }
    )
    createdWebhookIds.push(newWebhook.id)

    expect(newWebhook.id).not.toBe(orphanedId)

    try {
      await stripe.webhookEndpoints.retrieve(orphanedId)
      expect.fail('Orphaned webhook should have been deleted from Stripe')
    } catch (err: unknown) {
      const stripeError = err as { code?: string; type?: string }
      expect(stripeError.code).toBe('resource_missing')
    }
  })

  it('should handle concurrent execution without duplicates', async () => {
    const concurrentUrl = 'https://test-concurrent.example.com/stripe-webhooks'

    const promises = Array(5)
      .fill(null)
      .map(() => sync.webhook.findOrCreateManagedWebhook(concurrentUrl, { enabled_events: ['*'] }))

    const results = await Promise.all(promises)

    const uniqueIds = new Set(results.map((w) => w.id))
    expect(uniqueIds.size).toBe(1)

    createdWebhookIds.push(results[0].id)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const webhooks = await (sync.webhook as any).listManagedWebhooks()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matching = webhooks.filter((w: any) => w.url === concurrentUrl)
    expect(matching.length).toBe(1)
  })

  it('should isolate webhooks per account (if STRIPE_API_KEY_2 available)', async () => {
    const key2 = process.env.STRIPE_API_KEY_2
    if (!key2) {
      console.log('Skipping multi-account test: STRIPE_API_KEY_2 not set')
      return
    }

    const sync2 = await StripeSync.create({
      databaseUrl: container.databaseUrl,
      stripeSecretKey: key2,
    })

    const sharedUrl = 'https://test-shared.example.com/stripe-webhooks'

    const webhook1 = await sync.webhook.findOrCreateManagedWebhook(sharedUrl, {
      enabled_events: ['*'],
    })
    createdWebhookIds.push(webhook1.id)

    const webhook2 = await sync2.webhook.findOrCreateManagedWebhook(sharedUrl, {
      enabled_events: ['*'],
    })

    expect(webhook2.id).not.toBe(webhook1.id)

    try {
      await sync2.webhook.deleteManagedWebhook(webhook2.id)
    } catch {
      // Ignore
    }

    await sync2.postgresClient?.pool?.end()
  })
})
