import { describe, expect, it, vi } from 'vitest'
import { discoverListEndpoints, buildListFn, getListFn } from '../listFnResolver'
import { minimalStripeOpenApiSpec } from './fixtures/minimalSpec'
import type Stripe from 'stripe'

function mockStripe() {
  const listFn = vi.fn().mockResolvedValue({ data: [], has_more: false })
  return {
    customers: { list: listFn },
    plans: { list: listFn },
    products: { list: listFn },
    subscriptionItems: { list: listFn },
    checkout: { sessions: { list: listFn } },
    radar: { earlyFraudWarnings: { list: listFn } },
    entitlements: {
      activeEntitlements: { list: listFn },
      features: { list: listFn },
    },
    _listFn: listFn,
  }
}

describe('discoverListEndpoints', () => {
  it('maps table names to their API paths', () => {
    const endpoints = discoverListEndpoints(minimalStripeOpenApiSpec)

    expect(endpoints.get('customers')).toEqual({
      tableName: 'customers',
      resourceId: 'customer',
      apiPath: '/v1/customers',
    })
    expect(endpoints.get('checkout_sessions')).toEqual({
      tableName: 'checkout_sessions',
      resourceId: 'checkout.session',
      apiPath: '/v1/checkout/sessions',
    })
    expect(endpoints.get('early_fraud_warnings')).toEqual({
      tableName: 'early_fraud_warnings',
      resourceId: 'radar.early_fraud_warning',
      apiPath: '/v1/radar/early_fraud_warnings',
    })
  })

  it('skips paths with path parameters', () => {
    const spec = {
      ...minimalStripeOpenApiSpec,
      paths: {
        ...minimalStripeOpenApiSpec.paths,
        '/v1/customers/{customer}/sources': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object' as const,
                      properties: {
                        object: { type: 'string' as const, enum: ['list'] },
                        data: {
                          type: 'array' as const,
                          items: { $ref: '#/components/schemas/customer' },
                        },
                        has_more: { type: 'boolean' as const },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }
    const endpoints = discoverListEndpoints(spec)
    const paths = Array.from(endpoints.values()).map((e) => e.apiPath)
    expect(paths).not.toContain('/v1/customers/{customer}/sources')
  })

  it('returns empty map when spec has no paths', () => {
    const endpoints = discoverListEndpoints({ openapi: '3.0.0' })
    expect(endpoints.size).toBe(0)
  })
})

describe('buildListFn', () => {
  it('resolves a simple top-level path', async () => {
    const mock = mockStripe()
    const listFn = buildListFn(mock as unknown as Stripe, '/v1/customers')
    await listFn({ limit: 10 })
    expect(mock._listFn).toHaveBeenCalledWith({ limit: 10 })
  })

  it('resolves a nested namespace path', async () => {
    const mock = mockStripe()
    const listFn = buildListFn(mock as unknown as Stripe, '/v1/checkout/sessions')
    await listFn({ limit: 5 })
    expect(mock._listFn).toHaveBeenCalledWith({ limit: 5 })
  })

  it('converts snake_case segments to camelCase', async () => {
    const mock = mockStripe()
    const listFn = buildListFn(mock as unknown as Stripe, '/v1/subscription_items')
    await listFn({ limit: 1 })
    expect(mock._listFn).toHaveBeenCalled()
  })

  it('resolves deeply nested snake_case paths', async () => {
    const mock = mockStripe()
    const listFn = buildListFn(mock as unknown as Stripe, '/v1/radar/early_fraud_warnings')
    await listFn({ limit: 1 })
    expect(mock._listFn).toHaveBeenCalled()
  })

  it('throws when a path segment does not exist on the SDK', async () => {
    const mock = mockStripe()
    const listFn = buildListFn(mock as unknown as Stripe, '/v1/nonexistent_resource')
    await expect(() => listFn({ limit: 1 })).toThrow(/Stripe SDK has no property/)
  })
})

describe('getListFn', () => {
  it('returns a callable list function for a table name', async () => {
    const mock = mockStripe()
    const listFn = getListFn(
      mock as unknown as Stripe,
      'early_fraud_warnings',
      minimalStripeOpenApiSpec
    )
    const result = await listFn({ limit: 100 })
    expect(result).toEqual({ data: [], has_more: false })
    expect(mock._listFn).toHaveBeenCalledWith({ limit: 100 })
  })

  it('throws for an unknown table name', () => {
    const mock = mockStripe()
    expect(() =>
      getListFn(mock as unknown as Stripe, 'nonexistent', minimalStripeOpenApiSpec)
    ).toThrow(/No list endpoint found for table "nonexistent"/)
  })
})
