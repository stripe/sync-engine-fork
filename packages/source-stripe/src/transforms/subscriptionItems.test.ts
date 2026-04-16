import { describe, expect, it, vi } from 'vitest'
import { syncSubscriptionItems, upsertSubscriptionItems } from './subscriptionItems.js'

describe('upsertSubscriptionItems', () => {
  it('normalizes price from object to string id', async () => {
    const upsertMany = vi.fn().mockResolvedValue([])
    await upsertSubscriptionItems(
      [{ id: 'si_1', price: { id: 'price_abc' } }],
      'acct_test',
      upsertMany
    )

    const [items] = upsertMany.mock.calls[0] as [Record<string, unknown>[], string, string]
    expect(items[0].price).toBe('price_abc')
  })

  it('keeps price as-is when already a string', async () => {
    const upsertMany = vi.fn().mockResolvedValue([])
    await upsertSubscriptionItems(
      [{ id: 'si_1', price: 'price_xyz' }],
      'acct_test',
      upsertMany
    )

    const [items] = upsertMany.mock.calls[0] as [Record<string, unknown>[], string, string]
    expect(items[0].price).toBe('price_xyz')
  })

  it('defaults deleted to false when not set', async () => {
    const upsertMany = vi.fn().mockResolvedValue([])
    await upsertSubscriptionItems([{ id: 'si_1', price: 'price_1' }], 'acct_test', upsertMany)

    const [items] = upsertMany.mock.calls[0] as [Record<string, unknown>[], string, string]
    expect(items[0].deleted).toBe(false)
  })

  it('preserves deleted:true', async () => {
    const upsertMany = vi.fn().mockResolvedValue([])
    await upsertSubscriptionItems(
      [{ id: 'si_1', price: 'price_1', deleted: true }],
      'acct_test',
      upsertMany
    )

    const [items] = upsertMany.mock.calls[0] as [Record<string, unknown>[], string, string]
    expect(items[0].deleted).toBe(true)
  })

  it('defaults quantity to null when not set', async () => {
    const upsertMany = vi.fn().mockResolvedValue([])
    await upsertSubscriptionItems([{ id: 'si_1', price: 'price_1' }], 'acct_test', upsertMany)

    const [items] = upsertMany.mock.calls[0] as [Record<string, unknown>[], string, string]
    expect(items[0].quantity).toBeNull()
  })

  it('passes accountId and syncTimestamp to upsertMany', async () => {
    const upsertMany = vi.fn().mockResolvedValue([])
    await upsertSubscriptionItems(
      [{ id: 'si_1', price: 'price_1' }],
      'acct_123',
      upsertMany,
      '2024-01-01T00:00:00Z'
    )

    expect(upsertMany).toHaveBeenCalledWith(
      expect.any(Array),
      'subscription_items',
      'acct_123',
      '2024-01-01T00:00:00Z'
    )
  })
})

describe('syncSubscriptionItems', () => {
  it('upserts all items from all subscriptions', async () => {
    const upsertItems = vi.fn().mockResolvedValue(undefined)
    const markDeleted = vi.fn().mockResolvedValue({ rowCount: 0 })

    await syncSubscriptionItems({
      subscriptions: [
        { id: 'sub_1', items: { data: [{ id: 'si_1', price: 'price_1' }] } },
        { id: 'sub_2', items: { data: [{ id: 'si_2', price: 'price_2' }] } },
      ],
      accountId: 'acct_test',
      upsertItems,
      markDeleted,
    })

    expect(upsertItems).toHaveBeenCalledOnce()
    const [items] = upsertItems.mock.calls[0] as [{ id: string }[], string]
    expect(items.map((i) => i.id).sort()).toEqual(['si_1', 'si_2'])
  })

  it('calls markDeleted for each subscription with current item ids', async () => {
    const upsertItems = vi.fn().mockResolvedValue(undefined)
    const markDeleted = vi.fn().mockResolvedValue({ rowCount: 0 })

    await syncSubscriptionItems({
      subscriptions: [
        {
          id: 'sub_1',
          items: { data: [{ id: 'si_1', price: 'price_1' }, { id: 'si_2', price: 'price_1' }] },
        },
      ],
      accountId: 'acct_test',
      upsertItems,
      markDeleted,
    })

    expect(markDeleted).toHaveBeenCalledWith('sub_1', ['si_1', 'si_2'])
  })

  it('skips subscriptions without items.data', async () => {
    const upsertItems = vi.fn().mockResolvedValue(undefined)
    const markDeleted = vi.fn().mockResolvedValue({ rowCount: 0 })

    await syncSubscriptionItems({
      subscriptions: [
        { id: 'sub_1', items: { data: [] } },
        { id: 'sub_no_items' } as unknown as Parameters<typeof syncSubscriptionItems>[0]['subscriptions'][0],
      ],
      accountId: 'acct_test',
      upsertItems,
      markDeleted,
    })

    // Only sub_1 has items, so markDeleted called once
    expect(markDeleted).toHaveBeenCalledTimes(1)
    expect(markDeleted).toHaveBeenCalledWith('sub_1', [])
  })
})
