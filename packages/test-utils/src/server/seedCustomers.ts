import type pg from 'pg'
import { ensureObjectTable, upsertObjects } from '../db/storage.js'
import { applyCreatedTimestampRange } from '../seed/createdTimestamps.js'
import type { SeedCustomersForListServerOptions } from './types.js'

/**
 * Seed the `customers` table backing a Stripe list test server using a template from stripe-mock.
 */
export async function seedCustomersForStripeListServer(
  pool: pg.Pool,
  schema: string,
  options: SeedCustomersForListServerOptions,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)
): Promise<string[]> {
  const stripeMockUrl = (options.stripeMockUrl ?? 'http://localhost:12111').replace(/\/$/, '')
  const apiKey = options.stripeMockApiKey ?? 'sk_test_fake'
  const idPrefix = options.idPrefix ?? 'cus_test'
  const padLen = options.idPadLength ?? 5
  const batchSize = options.batchSize ?? 1000

  const templateRes = await fetchImpl(`${stripeMockUrl}/v1/customers`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  })
  if (!templateRes.ok) {
    throw new Error(
      `seedCustomers: stripe-mock POST /v1/customers failed (${templateRes.status}) — is stripe-mock up?`
    )
  }
  const customerTemplate = (await templateRes.json()) as Record<string, unknown>

  await ensureObjectTable(pool, schema, 'customers')

  const shells = Array.from({ length: options.count }, (_, i) => ({
    ...customerTemplate,
    id: `${idPrefix}_${String(i).padStart(padLen, '0')}`,
    created: 0,
  }))
  const objects = applyCreatedTimestampRange(shells, {
    startUnix: options.createdRange.startUnix,
    endUnix: options.createdRange.endUnix,
  })

  for (let i = 0; i < objects.length; i += batchSize) {
    await upsertObjects(pool, schema, 'customers', objects.slice(i, i + batchSize))
  }

  return objects.map((o) => o.id as string)
}
