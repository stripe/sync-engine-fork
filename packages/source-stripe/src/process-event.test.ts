import { describe, expect, it } from 'vitest'
import { fromStripeEvent, processStripeEvent } from './process-event.js'
import type { StripeEvent } from './spec.js'
import type { ResourceConfig } from './types.js'
import type { Config } from './index.js'

// Minimal registry with a customer and subscription entry
const registry: Record<string, ResourceConfig> = {
  customers: {
    order: 1,
    tableName: 'customers',
    supportsCreatedFilter: true,
  },
  subscriptions: {
    order: 2,
    tableName: 'subscriptions',
    supportsCreatedFilter: true,
  },
  products: {
    order: 3,
    tableName: 'products',
    supportsCreatedFilter: true,
  },
}

function makeEvent(overrides: Partial<StripeEvent> & { data?: Partial<StripeEvent['data']> }): StripeEvent {
  return {
    id: 'evt_test',
    object: 'event',
    api_version: '2022-11-15',
    created: 1700000000,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: 'customer.updated',
    data: {
      object: { id: 'cus_001', object: 'customer' },
      ...overrides.data,
    },
    ...overrides,
  } as StripeEvent
}

describe('fromStripeEvent', () => {
  it('returns null when data.object has no object field', () => {
    const event = makeEvent({ data: { object: {} } })
    expect(fromStripeEvent(event, registry)).toBeNull()
  })

  it('returns null when object type is not in registry', () => {
    const event = makeEvent({ data: { object: { id: 'dp_1', object: 'dispute' } } })
    expect(fromStripeEvent(event, registry)).toBeNull()
  })

  it('returns null when object has no id', () => {
    const event = makeEvent({ data: { object: { object: 'customer' } } })
    expect(fromStripeEvent(event, registry)).toBeNull()
  })

  it('returns record and state for a known object type', () => {
    const event = makeEvent({ type: 'customer.updated' })
    const result = fromStripeEvent(event, registry)
    expect(result).not.toBeNull()
    expect(result!.record.type).toBe('record')
    expect(result!.record.record.stream).toBe('customers')
    expect(result!.state.type).toBe('source_state')
    expect((result!.state.source_state as { data: { eventId: string } }).data.eventId).toBe('evt_test')
  })

  it('adds _account_id when accountId provided', () => {
    const event = makeEvent({ type: 'customer.updated' })
    const result = fromStripeEvent(event, registry, 'acct_123')
    expect(result!.record.record.data._account_id).toBe('acct_123')
  })

  it('does not add _account_id when accountId omitted', () => {
    const event = makeEvent({ type: 'customer.updated' })
    const result = fromStripeEvent(event, registry)
    expect(result!.record.record.data).not.toHaveProperty('_account_id')
  })
})

describe('processStripeEvent', () => {
  const catalog = {
    streams: [
      { stream: { name: 'customers' }, sync_mode: 'incremental' as const },
      { stream: { name: 'subscriptions' }, sync_mode: 'incremental' as const },
      { stream: { name: 'products' }, sync_mode: 'incremental' as const },
      { stream: { name: 'active_entitlements' }, sync_mode: 'incremental' as const },
    ],
  }
  const streamNames = new Set(['customers', 'subscriptions', 'products', 'active_entitlements'])
  const config: Config = {
    api_key: 'sk_test_abc',
    api_version: '2022-11-15',
  }

  async function collect(gen: AsyncGenerator<unknown>) {
    const msgs: unknown[] = []
    for await (const m of gen) msgs.push(m)
    return msgs
  }

  it('yields nothing when data.object has no object field', async () => {
    const event = makeEvent({ data: { object: {} } })
    const msgs = await collect(processStripeEvent(event, config, catalog, registry, streamNames))
    expect(msgs).toHaveLength(0)
  })

  it('yields nothing when object type not in registry', async () => {
    const event = makeEvent({ data: { object: { id: 'dp_1', object: 'dispute' } } })
    const msgs = await collect(processStripeEvent(event, config, catalog, registry, streamNames))
    expect(msgs).toHaveLength(0)
  })

  it('yields nothing when stream not in catalog', async () => {
    const limitedStreams = new Set(['products'])
    const event = makeEvent({ type: 'customer.updated' })
    const msgs = await collect(
      processStripeEvent(event, config, catalog, registry, limitedStreams)
    )
    expect(msgs).toHaveLength(0)
  })

  it('yields record + state for a normal update event', async () => {
    const event = makeEvent({ type: 'customer.updated' })
    const msgs = await collect(processStripeEvent(event, config, catalog, registry, streamNames))
    expect(msgs).toHaveLength(2)
    expect((msgs[0] as { type: string }).type).toBe('record')
    expect((msgs[1] as { type: string }).type).toBe('source_state')
  })

  it('yields record with deleted:true for delete events', async () => {
    const event = makeEvent({
      type: 'customer.deleted',
      data: { object: { id: 'cus_001', object: 'customer', deleted: true } },
    })
    const msgs = await collect(processStripeEvent(event, config, catalog, registry, streamNames))
    expect(msgs).toHaveLength(2)
    const record = msgs[0] as { type: string; record: { data: Record<string, unknown> } }
    expect(record.record.data.deleted).toBe(true)
  })

  it('detects delete via RESOURCE_DELETE_EVENTS set', async () => {
    const event = makeEvent({
      type: 'product.deleted',
      data: { object: { id: 'prod_1', object: 'product' } },
    })
    const msgs = await collect(processStripeEvent(event, config, catalog, registry, streamNames))
    expect(msgs).toHaveLength(2)
    const record = msgs[0] as { type: string; record: { data: Record<string, unknown> } }
    expect(record.record.data.deleted).toBe(true)
  })

  it('yields subscription items when subscription has items.data', async () => {
    const event = makeEvent({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          object: 'subscription',
          items: {
            data: [
              { id: 'si_1', object: 'subscription_item' },
              { id: 'si_2', object: 'subscription_item' },
            ],
          },
        },
      },
    })
    const msgs = await collect(processStripeEvent(event, config, catalog, registry, streamNames))
    // subscription record + 2 subscription_item records + state
    expect(msgs.length).toBeGreaterThanOrEqual(3)
    const recordTypes = (msgs as { type: string; record?: { stream: string } }[])
      .filter((m) => m.type === 'record')
      .map((m) => m.record?.stream)
    expect(recordTypes).toContain('subscription_items')
  })

  it('handles entitlements.active_entitlement_summary.updated', async () => {
    const event = makeEvent({
      type: 'entitlements.active_entitlement_summary.updated',
      data: {
        object: {
          object: 'entitlements.active_entitlement_summary',
          customer: 'cus_001',
          entitlements: {
            data: [
              {
                id: 'ent_1',
                object: 'entitlements.active_entitlement',
                feature: 'feat_1',
                livemode: false,
                lookup_key: 'key_1',
              },
            ],
          },
        },
      },
    })
    const msgs = await collect(processStripeEvent(event, config, catalog, registry, streamNames))
    expect(msgs).toHaveLength(2) // 1 record + 1 state
    expect((msgs[0] as { type: string }).type).toBe('record')
  })

  it('skips entitlement summary when active_entitlements not in streams', async () => {
    const limited = new Set(['customers'])
    const event = makeEvent({
      type: 'entitlements.active_entitlement_summary.updated',
      data: {
        object: {
          object: 'entitlements.active_entitlement_summary',
          customer: 'cus_001',
          entitlements: { data: [] },
        },
      },
    })
    const msgs = await collect(processStripeEvent(event, config, catalog, registry, limited))
    expect(msgs).toHaveLength(0)
  })
})
