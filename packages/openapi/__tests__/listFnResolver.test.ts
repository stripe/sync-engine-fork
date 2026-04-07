import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildListFn, buildRetrieveFn, discoverListEndpoints } from '../listFnResolver'
import { minimalStripeOpenApiSpec } from './fixtures/minimalSpec'

afterEach(() => {
  vi.useRealTimers()
})

describe('discoverListEndpoints', () => {
  it('maps table names to their API paths', () => {
    const endpoints = discoverListEndpoints(minimalStripeOpenApiSpec)

    expect(endpoints.get('customers')).toEqual({
      tableName: 'customers',
      resourceId: 'customer',
      apiPath: '/v1/customers',
      supportsCreatedFilter: true,
      supportsLimit: true,
    })
    expect(endpoints.get('checkout_sessions')).toEqual({
      tableName: 'checkout_sessions',
      resourceId: 'checkout.session',
      apiPath: '/v1/checkout/sessions',
      supportsCreatedFilter: true,
      supportsLimit: true,
    })
    expect(endpoints.get('early_fraud_warnings')).toEqual({
      tableName: 'early_fraud_warnings',
      resourceId: 'radar.early_fraud_warning',
      apiPath: '/v1/radar/early_fraud_warnings',
      supportsCreatedFilter: true,
      supportsLimit: true,
    })
  })

  it('discovers v2 list endpoints using next_page_url format', () => {
    const endpoints = discoverListEndpoints(minimalStripeOpenApiSpec)

    expect(endpoints.get('v2_core_accounts')).toEqual({
      tableName: 'v2_core_accounts',
      resourceId: 'v2.core.account',
      apiPath: '/v2/core/accounts',
      supportsCreatedFilter: false,
      supportsLimit: false,
    })
    expect(endpoints.get('v2_core_event_destinations')).toEqual({
      tableName: 'v2_core_event_destinations',
      resourceId: 'v2.core.event_destination',
      apiPath: '/v2/core/event_destinations',
      supportsCreatedFilter: false,
      supportsLimit: false,
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

  it('uses the injected fetch for list and retrieve calls', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 })
    )
    const list = buildListFn('sk_test_fake', '/v1/customers', fetchMock)
    const retrieve = buildRetrieveFn('sk_test_fake', '/v1/customers', fetchMock)
    await list({ limit: 1 })
    await retrieve('cus_123')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses the injected fetch for localhost base URLs', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 })
    )
    const list = buildListFn(
      'sk_test_fake',
      '/v1/customers',
      fetchMock,
      undefined,
      'http://localhost:12111'
    )
    await list({ limit: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('http://localhost:12111'),
      expect.anything()
    )
  })

  it('retries transient list failures and eventually succeeds', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { type: 'api_error', message: 'Temporary outage' },
          }),
          { status: 500 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'cus_123' }], has_more: false }), {
          status: 200,
        })
      )
    const list = buildListFn('sk_test_fake', '/v1/customers', fetchMock)

    const pending = list({ limit: 1 })
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toEqual({ data: [{ id: 'cus_123' }], has_more: false })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws the Stripe error message for non-2xx list responses', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              message: 'Invalid API Key provided: sk_test_bad',
            },
          }),
          { status: 401 }
        )
    )
    const list = buildListFn('sk_test_bad', '/v1/customers', fetchMock)

    await expect(list({ limit: 1 })).rejects.toThrow('Invalid API Key provided: sk_test_bad')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws for v2 non-2xx list responses', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { type: 'api_error', message: 'Injected page failure' },
          }),
          { status: 500 }
        )
    )
    const list = buildListFn('sk_test_fake', '/v2/core/accounts', fetchMock)

    const pending = expect(list({ limit: 1 })).rejects.toThrow('Injected page failure')
    await vi.runAllTimersAsync()
    await pending
  })

  it('throws the Stripe error message for non-2xx retrieve responses', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { type: 'invalid_request_error', message: "No such customer: 'cus_missing'" },
          }),
          { status: 404 }
        )
    )
    const retrieve = buildRetrieveFn('sk_test_fake', '/v1/customers', fetchMock)

    await expect(retrieve('cus_missing')).rejects.toThrow("No such customer: 'cus_missing'")
  })
})
