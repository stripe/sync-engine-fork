import { describe, expect, it, vi } from 'vitest'
import { backfillDependencies } from './backfillDependencies.js'
import type { ResourceConfig } from '../types.js'

const registry: Record<string, ResourceConfig> = {
  invoices: {
    order: 1,
    tableName: 'invoices',
    supportsCreatedFilter: true,
    dependencies: ['customers', 'subscriptions'],
  },
  charges: {
    order: 2,
    tableName: 'charges',
    supportsCreatedFilter: true,
    // no dependencies
  },
}

describe('backfillDependencies', () => {
  it('calls backfillAny for each dependency with unique ids', async () => {
    const backfillAny = vi.fn().mockResolvedValue([])
    const items = [
      { customers: 'cus_1', subscriptions: 'sub_1' },
      { customers: 'cus_2', subscriptions: 'sub_1' }, // sub_1 duplicate
      { customers: 'cus_1' }, // cus_1 duplicate
    ]

    await backfillDependencies({
      items,
      syncObjectName: 'invoices',
      accountId: 'acct_123',
      registry,
      backfillAny,
    })

    expect(backfillAny).toHaveBeenCalledTimes(2)
    const callsMap = new Map(backfillAny.mock.calls.map((c) => [c[1] as string, c[0] as string[]]))
    expect(callsMap.get('customers')?.sort()).toEqual(['cus_1', 'cus_2'])
    expect(callsMap.get('subscriptions')).toEqual(['sub_1'])
  })

  it('passes accountId and syncTimestamp through', async () => {
    const backfillAny = vi.fn().mockResolvedValue([])
    await backfillDependencies({
      items: [{ customers: 'cus_1' }],
      syncObjectName: 'invoices',
      accountId: 'acct_abc',
      syncTimestamp: '2024-01-01T00:00:00Z',
      registry,
      backfillAny,
    })

    expect(backfillAny).toHaveBeenCalledWith(
      ['cus_1'],
      'customers',
      'acct_abc',
      '2024-01-01T00:00:00Z'
    )
  })

  it('does nothing when object has no dependencies', async () => {
    const backfillAny = vi.fn()
    await backfillDependencies({
      items: [{ customers: 'cus_1' }],
      syncObjectName: 'charges',
      accountId: 'acct_abc',
      registry,
      backfillAny,
    })
    expect(backfillAny).not.toHaveBeenCalled()
  })

  it('does nothing when object is not in registry', async () => {
    const backfillAny = vi.fn()
    await backfillDependencies({
      items: [{ customers: 'cus_1' }],
      syncObjectName: 'unknown_object',
      accountId: 'acct_abc',
      registry,
      backfillAny,
    })
    expect(backfillAny).not.toHaveBeenCalled()
  })

  it('filters out null/undefined dependency values', async () => {
    const backfillAny = vi.fn().mockResolvedValue([])
    const items = [
      { customers: 'cus_1', subscriptions: null },
      { customers: undefined, subscriptions: 'sub_1' },
    ]
    await backfillDependencies({
      items,
      syncObjectName: 'invoices',
      accountId: 'acct_abc',
      registry,
      backfillAny,
    })

    const callsMap = new Map(backfillAny.mock.calls.map((c) => [c[1] as string, c[0] as string[]]))
    expect(callsMap.get('customers')).toEqual(['cus_1'])
    expect(callsMap.get('subscriptions')).toEqual(['sub_1'])
  })
})
