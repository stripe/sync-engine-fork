import { describe, it, expect, vi, beforeEach } from 'vitest'
import Stripe from 'stripe'
import { createMockedStripeSync, mockStripeResource } from '../testSetup'
import type { StripeSync } from '../../stripeSync'

describe('Manual Pagination with Rate Limit Handling', () => {
  let sync: StripeSync
  let mockCustomersList: ReturnType<typeof vi.fn>
  let mockPaymentMethodsList: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.useFakeTimers()

    sync = await createMockedStripeSync({
      stripeSecretKey: 'sk_test_123',
      poolConfig: { connectionString: 'postgresql://test' },
    })

    const mocks = mockStripeResource(sync, 'customers', ['list'])
    mockCustomersList = mocks.list

    const pmMocks = mockStripeResource(sync, 'paymentMethods', ['list'])
    mockPaymentMethodsList = pmMocks.list
  })

  it('should handle 429 rate limit during manual pagination and retry successfully', async () => {
    const rateLimitError = new Stripe.errors.StripeRateLimitError({
      message: 'Rate limit exceeded',
    } as Stripe.StripeRawError)

    const successResponse: Stripe.ApiList<Stripe.Customer> = {
      object: 'list' as const,
      data: [{ id: 'cus_1' }, { id: 'cus_2' }] as Stripe.Customer[],
      has_more: false,
      url: '/v1/customers',
    }

    mockCustomersList.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce(successResponse)

    const fetchPage = async (startingAfter?: string) => {
      return await mockCustomersList({
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      })
    }

    const allData: Stripe.Customer[] = []
    let hasMore = true
    let startingAfter: string | undefined = undefined

    while (hasMore) {
      try {
        const response = await fetchPage(startingAfter)
        allData.push(...response.data)
        hasMore = response.has_more
        if (response.data.length > 0) {
          startingAfter = response.data[response.data.length - 1].id
        }
      } catch (error) {
        if (error instanceof Stripe.errors.StripeRateLimitError) {
          await vi.advanceTimersByTimeAsync(100)
          continue
        }
        throw error
      }
    }

    expect(allData).toHaveLength(2)
    expect(allData[0].id).toBe('cus_1')
    expect(allData[1].id).toBe('cus_2')
    expect(mockCustomersList).toHaveBeenCalledTimes(2)
  })

  it('should handle 429 during payment method pagination with multiple pages', async () => {
    const page1: Stripe.ApiList<Stripe.PaymentMethod> = {
      object: 'list' as const,
      data: [{ id: 'pm_1' }] as Stripe.PaymentMethod[],
      has_more: true,
      url: '/v1/payment_methods',
    }

    const rateLimitError = new Stripe.errors.StripeRateLimitError({
      message: 'Rate limit exceeded',
    } as Stripe.StripeRawError)

    const page2: Stripe.ApiList<Stripe.PaymentMethod> = {
      object: 'list' as const,
      data: [{ id: 'pm_2' }] as Stripe.PaymentMethod[],
      has_more: false,
      url: '/v1/payment_methods',
    }

    mockPaymentMethodsList
      .mockResolvedValueOnce(page1)
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce(page2)

    const allData: Stripe.PaymentMethod[] = []
    let hasMore = true
    let startingAfter: string | undefined = undefined
    let retryCount = 0
    const maxRetries = 3

    while (hasMore) {
      try {
        const response: Stripe.ApiList<Stripe.PaymentMethod> = await mockPaymentMethodsList({
          limit: 100,
          customer: 'cus_123',
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        })

        allData.push(...response.data)
        hasMore = response.has_more
        if (response.data.length > 0) {
          startingAfter = response.data[response.data.length - 1].id
        }
        retryCount = 0
      } catch (error) {
        if (error instanceof Stripe.errors.StripeRateLimitError && retryCount < maxRetries) {
          retryCount++
          await vi.advanceTimersByTimeAsync(100 * Math.pow(2, retryCount - 1))
          continue
        }
        throw error
      }
    }

    expect(allData).toHaveLength(2)
    expect(allData[0].id).toBe('pm_1')
    expect(allData[1].id).toBe('pm_2')
    expect(mockPaymentMethodsList).toHaveBeenCalledTimes(3)
  })

  it('should respect has_more flag and stop pagination', async () => {
    const page1: Stripe.ApiList<Stripe.Customer> = {
      object: 'list' as const,
      data: [{ id: 'cus_1' }] as Stripe.Customer[],
      has_more: true,
      url: '/v1/customers',
    }

    const page2: Stripe.ApiList<Stripe.Customer> = {
      object: 'list' as const,
      data: [{ id: 'cus_2' }] as Stripe.Customer[],
      has_more: false,
      url: '/v1/customers',
    }

    mockCustomersList.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2)

    const allData: Stripe.Customer[] = []
    let hasMore = true
    let startingAfter: string | undefined = undefined

    while (hasMore) {
      const response: Stripe.ApiList<Stripe.Customer> = await mockCustomersList({
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      })

      allData.push(...response.data)
      hasMore = response.has_more
      if (response.data.length > 0) {
        startingAfter = response.data[response.data.length - 1].id
      }
    }

    expect(allData).toHaveLength(2)
    expect(mockCustomersList).toHaveBeenCalledTimes(2)
    expect(mockCustomersList).toHaveBeenNthCalledWith(2, {
      limit: 100,
      starting_after: 'cus_1',
    })
  })
})
