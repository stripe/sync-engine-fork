import { describe, expect, it, vi } from 'vitest'
import { expandEntity } from './expandEntity.js'
import type { StripeApiList } from '@stripe/sync-openapi'

function makeList<T extends { id?: string }>(
  data: T[],
  has_more = false
): StripeApiList<T> {
  return { object: 'list', data, has_more, url: '/v1/test' }
}

describe('expandEntity', () => {
  it('does nothing when list is already complete (has_more=false)', async () => {
    const listFn = vi.fn()
    const entities = [
      { id: 'sub_1', items: makeList([{ id: 'si_1' }, { id: 'si_2' }], false) },
    ]

    await expandEntity(entities, 'items', listFn)

    expect(listFn).not.toHaveBeenCalled()
    expect(entities[0].items.data).toHaveLength(2)
  })

  it('fetches all pages when has_more=true', async () => {
    const listFn = vi
      .fn()
      .mockResolvedValueOnce(makeList([{ id: 'si_1' }, { id: 'si_2' }], true))
      .mockResolvedValueOnce(makeList([{ id: 'si_3' }], false))

    const entities = [{ id: 'sub_1', items: makeList([], true) }]
    await expandEntity(entities, 'items', listFn)

    expect(listFn).toHaveBeenCalledTimes(2)
    expect(listFn).toHaveBeenNthCalledWith(1, 'sub_1', undefined)
    expect(listFn).toHaveBeenNthCalledWith(2, 'sub_1', { starting_after: 'si_2' })
    expect(entities[0].items.data).toHaveLength(3)
    expect(entities[0].items.has_more).toBe(false)
  })

  it('fetches when property is missing (no existing list)', async () => {
    const listFn = vi.fn().mockResolvedValueOnce(makeList([{ id: 'si_1' }], false))
    const entities: { id: string; items?: StripeApiList<{ id: string }> | null }[] = [
      { id: 'sub_1', items: null },
    ]

    await expandEntity(entities, 'items', listFn)

    expect(listFn).toHaveBeenCalledOnce()
    expect(entities[0].items!.data).toHaveLength(1)
  })

  it('processes multiple entities independently', async () => {
    const listFn = vi
      .fn()
      .mockResolvedValueOnce(makeList([{ id: 'si_a1' }], false))
      .mockResolvedValueOnce(makeList([{ id: 'si_b1' }, { id: 'si_b2' }], false))

    const entities = [
      { id: 'sub_1', items: makeList([], true) },
      { id: 'sub_2', items: makeList([], true) },
    ]

    await expandEntity(entities, 'items', listFn)

    expect(listFn).toHaveBeenCalledTimes(2)
    expect(entities[0].items.data).toHaveLength(1)
    expect(entities[1].items.data).toHaveLength(2)
  })

  it('handles an empty first page (no starting_after set)', async () => {
    const listFn = vi.fn().mockResolvedValueOnce(makeList([], false))
    const entities = [{ id: 'sub_1', items: makeList([], true) }]

    await expandEntity(entities, 'items', listFn)

    expect(listFn).toHaveBeenCalledTimes(1)
    expect(entities[0].items.data).toHaveLength(0)
  })
})
