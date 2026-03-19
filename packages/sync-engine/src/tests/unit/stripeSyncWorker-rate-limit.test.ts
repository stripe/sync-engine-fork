import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Stripe from 'stripe'
import { StripeSyncWorker } from '../../stripeSyncWorker'
import type { ResourceConfig, StripeSyncConfig } from '../../types'

describe('StripeSyncWorker rate limit handling', () => {
  const runStartedAt = new Date('2024-01-01T00:00:00Z')

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('requeues a claimed task when Stripe rate limits task processing', async () => {
    const warn = vi.fn()
    const error = vi.fn()
    const claimNextTask = vi
      .fn()
      .mockResolvedValueOnce({
        object: 'customers',
        cursor: '1700000000',
        pageCursor: 'cus_existing',
        created_gte: 1,
        created_lte: 2,
      })
      .mockResolvedValueOnce(null)
    const updateSyncObject = vi.fn().mockResolvedValue(0)
    const rateLimitError = new Stripe.errors.StripeRateLimitError({
      message: 'Rate limit exceeded',
    } as Stripe.StripeRawError)
    const listFn = vi.fn().mockRejectedValueOnce(rateLimitError)

    const worker = new StripeSyncWorker(
      {} as Stripe,
      {
        enableSigma: false,
        logger: { info: vi.fn(), warn, error },
      } as StripeSyncConfig,
      {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      {
        claimNextTask,
        updateSyncObject,
      } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      'acct_test',
      {
        customer: {
          tableName: 'customers',
          order: 0,
          supportsCreatedFilter: true,
          listFn,
        },
      } as Record<string, ResourceConfig>,
      {},
      { accountId: 'acct_test', runStartedAt },
      vi.fn() as any // eslint-disable-line @typescript-eslint/no-explicit-any
    )

    worker.start()
    const done = worker.waitUntilDone()
    await vi.runAllTimersAsync()
    await done

    expect(updateSyncObject).toHaveBeenCalledWith('acct_test', runStartedAt, 'customers', 1, 2, {
      status: 'pending',
      cursor: '1700000000',
      pageCursor: 'cus_existing',
    })
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ object: 'customers', source: 'processSingleTask', waitMs: 1000 }),
      'Rate limited on processSingleTask, backing off 1000ms'
    )
    expect(error).not.toHaveBeenCalled()
  })

  it('logs claimNextTask when the database limiter rejects a claim', async () => {
    const warn = vi.fn()
    const claimNextTask = vi
      .fn()
      .mockRejectedValueOnce(new Error('Rate limit exceeded for claimNextTask'))
      .mockResolvedValueOnce(null)
    const updateSyncObject = vi.fn().mockResolvedValue(0)

    const worker = new StripeSyncWorker(
      {} as Stripe,
      {
        enableSigma: false,
        logger: { info: vi.fn(), warn, error: vi.fn() },
      } as StripeSyncConfig,
      {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      {
        claimNextTask,
        updateSyncObject,
      } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      'acct_test',
      {},
      {},
      { accountId: 'acct_test', runStartedAt },
      vi.fn() as any // eslint-disable-line @typescript-eslint/no-explicit-any
    )

    worker.start()
    const done = worker.waitUntilDone()
    await vi.runAllTimersAsync()
    await done

    expect(updateSyncObject).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ object: undefined, source: 'claimNextTask', waitMs: 250 }),
      'Rate limited on claimNextTask, backing off 250ms'
    )
  })
})
