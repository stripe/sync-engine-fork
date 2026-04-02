import { describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { createMockedStripeSync } from '../testSetup'

describe('entitlements webhook pagination', () => {
  it('calls activeEntitlements.list when the webhook summary is truncated', async () => {
    const stripeSync = await createMockedStripeSync()
    const listSpy = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'ae_1',
          object: 'entitlements.active_entitlement',
          feature: { id: 'feat_1' },
          livemode: false,
          lookup_key: 'feature-1',
        },
      ],
      has_more: false,
    })
    const upsertSpy = vi.fn().mockResolvedValue([])
    const deleteSpy = vi.fn().mockResolvedValue(undefined)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.stripe.entitlements.activeEntitlements.list = listSpy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.upsertAny = upsertSpy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.postgresClient.deleteRemovedActiveEntitlements = deleteSpy

    const event = {
      id: 'evt_entitlements_truncated',
      type: 'entitlements.active_entitlement_summary.updated',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          customer: 'cus_123',
          entitlements: {
            data: [],
            has_more: true,
          },
        },
      },
    } as unknown as Stripe.Event

    await stripeSync.webhook.handleEntitlementSummaryEvent(event, 'acct_test')

    expect(listSpy).toHaveBeenCalledWith({
      customer: 'cus_123',
      limit: 100,
    })
    expect(deleteSpy).toHaveBeenCalledWith('cus_123', ['ae_1'])
    expect(upsertSpy).toHaveBeenCalledWith(
      [
        {
          id: 'ae_1',
          object: 'entitlements.active_entitlement',
          feature: 'feat_1',
          customer: 'cus_123',
          livemode: false,
          lookup_key: 'feature-1',
        },
      ],
      'acct_test',
      false,
      expect.any(String)
    )
  })

  it('fetches all entitlement pages and upserts the combined results', async () => {
    const stripeSync = await createMockedStripeSync()
    const listSpy = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: 'ae_1',
            object: 'entitlements.active_entitlement',
            feature: { id: 'feat_1' },
            livemode: false,
            lookup_key: 'feature-1',
          },
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'ae_2',
            object: 'entitlements.active_entitlement',
            feature: { id: 'feat_2' },
            livemode: false,
            lookup_key: 'feature-2',
          },
        ],
        has_more: false,
      })
    const upsertSpy = vi.fn().mockResolvedValue([])
    const deleteSpy = vi.fn().mockResolvedValue(undefined)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.stripe.entitlements.activeEntitlements.list = listSpy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.upsertAny = upsertSpy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.postgresClient.deleteRemovedActiveEntitlements = deleteSpy

    const event = {
      id: 'evt_entitlements_multipage',
      type: 'entitlements.active_entitlement_summary.updated',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          customer: 'cus_123',
          entitlements: {
            data: [],
            has_more: true,
          },
        },
      },
    } as unknown as Stripe.Event

    await stripeSync.webhook.handleEntitlementSummaryEvent(event, 'acct_test')

    expect(listSpy).toHaveBeenNthCalledWith(1, {
      customer: 'cus_123',
      limit: 100,
    })
    expect(listSpy).toHaveBeenNthCalledWith(2, {
      customer: 'cus_123',
      limit: 100,
      starting_after: 'ae_1',
    })
    expect(deleteSpy).toHaveBeenCalledWith('cus_123', ['ae_1', 'ae_2'])
    expect(upsertSpy).toHaveBeenCalledWith(
      [
        {
          id: 'ae_1',
          object: 'entitlements.active_entitlement',
          feature: 'feat_1',
          customer: 'cus_123',
          livemode: false,
          lookup_key: 'feature-1',
        },
        {
          id: 'ae_2',
          object: 'entitlements.active_entitlement',
          feature: 'feat_2',
          customer: 'cus_123',
          livemode: false,
          lookup_key: 'feature-2',
        },
      ],
      'acct_test',
      false,
      expect.any(String)
    )
  })

  it('uses the webhook body directly when has_more is false', async () => {
    const stripeSync = await createMockedStripeSync()
    const listSpy = vi.fn()
    const upsertSpy = vi.fn().mockResolvedValue([])
    const deleteSpy = vi.fn().mockResolvedValue(undefined)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.stripe.entitlements.activeEntitlements.list = listSpy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.upsertAny = upsertSpy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.postgresClient.deleteRemovedActiveEntitlements = deleteSpy

    const event = {
      id: 'evt_entitlements_inline',
      type: 'entitlements.active_entitlement_summary.updated',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          customer: 'cus_123',
          entitlements: {
            data: [
              {
                id: 'ae_inline',
                object: 'entitlements.active_entitlement',
                feature: { id: 'feat_inline' },
                livemode: false,
                lookup_key: 'feature-inline',
              },
            ],
            has_more: false,
          },
        },
      },
    } as unknown as Stripe.Event

    await stripeSync.webhook.handleEntitlementSummaryEvent(event, 'acct_test')

    expect(listSpy).not.toHaveBeenCalled()
    expect(deleteSpy).toHaveBeenCalledWith('cus_123', ['ae_inline'])
    expect(upsertSpy).toHaveBeenCalledWith(
      [
        {
          id: 'ae_inline',
          object: 'entitlements.active_entitlement',
          feature: 'feat_inline',
          customer: 'cus_123',
          livemode: false,
          lookup_key: 'feature-inline',
        },
      ],
      'acct_test',
      false,
      expect.any(String)
    )
  })
})
