import { describe, expect, it } from 'vitest'
import { SpecParser, RUNTIME_REQUIRED_TABLES, OPENAPI_RESOURCE_TABLE_ALIASES } from '../specParser'
import { minimalStripeOpenApiSpec } from './fixtures/minimalSpec'
import { resolveOpenApiSpec } from '../specFetchHelper'

describe('SpecParser', () => {
  it('parses aliased resources into deterministic tables and column types', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(minimalStripeOpenApiSpec, {
      allowedTables: ['checkout_sessions', 'customers', 'early_fraud_warnings'],
    })

    expect(parsed.tables.map((table) => table.tableName)).toEqual([
      'checkout_sessions',
      'customers',
      'early_fraud_warnings',
    ])

    const customers = parsed.tables.find((table) => table.tableName === 'customers')
    expect(customers?.sourcePaths).toEqual(['/v1/customers'])
    expect(customers?.columns).toEqual([
      { name: 'created', type: 'bigint', nullable: false },
      { name: 'deleted', type: 'boolean', nullable: false },
      { name: 'object', type: 'text', nullable: false },
    ])

    const checkoutSessions = parsed.tables.find((table) => table.tableName === 'checkout_sessions')
    expect(checkoutSessions?.columns).toContainEqual({
      name: 'amount_total',
      type: 'bigint',
      nullable: false,
    })
  })

  it('injects compatibility columns for runtime-critical tables', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        paths: {},
        components: { schemas: {} },
      },
      { allowedTables: ['active_entitlements', 'subscription_items'] }
    )

    const activeEntitlements = parsed.tables.find(
      (table) => table.tableName === 'active_entitlements'
    )
    expect(activeEntitlements?.columns).toContainEqual({
      name: 'customer',
      type: 'text',
      nullable: true,
    })

    const subscriptionItems = parsed.tables.find(
      (table) => table.tableName === 'subscription_items'
    )
    expect(subscriptionItems?.columns).toContainEqual({
      name: 'deleted',
      type: 'boolean',
      nullable: true,
    })
    expect(subscriptionItems?.columns).toContainEqual({
      name: 'subscription',
      type: 'text',
      nullable: true,
    })
  })

  it('is deterministic regardless of schema key order', () => {
    const parser = new SpecParser()
    const normal = parser.parse(minimalStripeOpenApiSpec, {
      allowedTables: ['customers', 'plans', 'prices'],
    })

    const reversedSchemas = Object.fromEntries(
      Object.entries(minimalStripeOpenApiSpec.components?.schemas ?? {}).reverse()
    )
    const reversed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        components: {
          schemas: reversedSchemas,
        },
      },
      { allowedTables: ['customers', 'plans', 'prices'] }
    )

    expect(reversed).toEqual(normal)
  })

  it('marks expandable references from x-expansionResources metadata', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        paths: {
          '/v1/charges': {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          data: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/charge' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            charge: {
              'x-resourceId': 'charge',
              type: 'object',
              properties: {
                id: { type: 'string' },
                customer: {
                  anyOf: [{ type: 'string' }, { $ref: '#/components/schemas/customer' }],
                  'x-expansionResources': {
                    oneOf: [{ $ref: '#/components/schemas/customer' }],
                  },
                },
              },
            },
            customer: {
              'x-resourceId': 'customer',
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
          },
        },
      },
      { allowedTables: ['charges'] }
    )

    const charges = parsed.tables.find((table) => table.tableName === 'charges')
    expect(charges?.columns).toContainEqual({
      name: 'customer',
      type: 'json',
      nullable: false,
      expandableReference: true,
      referenceResourceIds: ['customer'],
    })
  })
})

describe('SpecParser - Table Modes (runtime_required vs all_projected)', () => {
  it('omitting allowedTables parses every GET collection list-backed minimal-spec table', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(minimalStripeOpenApiSpec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })

    expect(parsed.tables.map((table) => table.tableName)).toEqual([
      'active_entitlements',
      'checkout_sessions',
      'customers',
      'early_fraud_warnings',
      'features',
      'plans',
      'prices',
      'products',
      'subscription_items',
    ])
    expect(parsed.tables.some((table) => table.tableName === 'deleted_customers')).toBe(false)
    expect(parsed.tables.some((table) => table.tableName === 'ephemeral_keys')).toBe(false)
  })

  it('keeps explicit allowedTables filtering and compatibility fallbacks', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(minimalStripeOpenApiSpec, {
      allowedTables: ['checkout_session_line_items', 'customers'],
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })

    expect(parsed.tables.map((table) => table.tableName)).toEqual([
      'checkout_session_line_items',
      'customers',
    ])

    const checkoutSessionLineItems = parsed.tables.find(
      (table) => table.tableName === 'checkout_session_line_items'
    )
    expect(checkoutSessionLineItems?.columns).toContainEqual({
      name: 'checkout_session',
      type: 'text',
      nullable: true,
    })
    expect(checkoutSessionLineItems?.columns).toContainEqual({
      name: 'amount_discount',
      type: 'bigint',
      nullable: true,
    })
  })

  it('keeps non-list-backed variants out even when explicitly allowed', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(minimalStripeOpenApiSpec, {
      allowedTables: ['customers', 'deleted_customers', 'ephemeral_keys'],
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })

    expect(parsed.tables.map((table) => table.tableName)).toEqual(['customers'])
    expect(parsed.tables.some((table) => table.tableName === 'deleted_customers')).toBe(false)
  })

  it('projects v2 collection resources when list items expose x-resourceId', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        openapi: '3.0.0',
        info: { version: '2026-02-25' },
        paths: {
          '/v2/core/accounts': {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          data: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/v2.core.account' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            'v2.core.account': {
              'x-resourceId': 'v2.core.account',
              type: 'object',
              properties: {
                id: { type: 'string' },
                created: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      {
        resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
      }
    )

    expect(parsed.tables.map((table) => table.tableName)).toEqual(['v2_core_accounts'])
    expect(parsed.tables[0]?.sourcePaths).toEqual(['/v2/core/accounts'])
  })

  it('keeps collection_backed scope limited to list responses', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        openapi: '3.0.0',
        info: { version: '2026-02-25' },
        paths: {
          '/v1/ephemeral_keys': {
            post: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: { $ref: '#/components/schemas/ephemeral_key' },
                    },
                  },
                },
              },
            },
          },
          '/v1/customers/{customer}': {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        anyOf: [
                          { $ref: '#/components/schemas/customer' },
                          { $ref: '#/components/schemas/deleted_customer' },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
          '/v2/core/account_links': {
            post: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: { $ref: '#/components/schemas/v2.core.account_link' },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            customer: {
              'x-resourceId': 'customer',
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
            deleted_customer: {
              'x-resourceId': 'deleted_customer',
              type: 'object',
              properties: {
                id: { type: 'string' },
                deleted: { type: 'boolean' },
              },
            },
            ephemeral_key: {
              'x-resourceId': 'ephemeral_key',
              type: 'object',
              properties: {
                id: { type: 'string' },
                secret: { type: 'string' },
              },
            },
            'v2.core.account_link': {
              'x-resourceId': 'v2.core.account_link',
              type: 'object',
              properties: {
                id: { type: 'string' },
                object: { type: 'string' },
              },
            },
          },
        },
      },
      {
        resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
      }
    )

    expect(parsed.tables).toEqual([])
  })

  it('get_backed scope keeps GET-retrievable resources, recovers SDK GET metadata, and excludes post-only/deleted variants', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        openapi: '3.0.0',
        info: { version: '2026-02-25' },
        paths: {
          '/v1/ephemeral_keys': {
            post: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: { $ref: '#/components/schemas/ephemeral_key' },
                    },
                  },
                },
              },
            },
          },
          '/v1/customers/{customer}': {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        anyOf: [
                          { $ref: '#/components/schemas/customer' },
                          { $ref: '#/components/schemas/deleted_customer' },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
          '/v1/tax/calculations/{calculation}': {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          calculation: {
                            $ref: '#/components/schemas/tax.calculation',
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '/v2/core/account_links': {
            post: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: { $ref: '#/components/schemas/v2.core.account_link' },
                    },
                  },
                },
              },
            },
          },
          '/v2/core/accounts/{account_id}/persons': {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          data: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/v2.core.account_person' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '/v2/core/events': {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          data: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/v2.core.event' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            customer: {
              'x-resourceId': 'customer',
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
            deleted_customer: {
              'x-resourceId': 'deleted_customer',
              type: 'object',
              properties: {
                id: { type: 'string' },
                deleted: { type: 'boolean' },
              },
            },
            ephemeral_key: {
              'x-resourceId': 'ephemeral_key',
              type: 'object',
              properties: {
                id: { type: 'string' },
                secret: { type: 'string' },
              },
            },
            'tax.calculation': {
              'x-resourceId': 'tax.calculation',
              'x-stripeOperations': [
                {
                  method_name: 'retrieve',
                  path: '/v1/tax/calculations/{calculation}',
                },
              ],
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
            'v2.core.account_link': {
              'x-resourceId': 'v2.core.account_link',
              type: 'object',
              properties: {
                id: { type: 'string' },
                object: { type: 'string' },
              },
            },
            'v2.core.account_person': {
              'x-resourceId': 'v2.core.account_person',
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
            'v2.core.event': {
              'x-resourceId': 'v2.core.event',
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
          },
        },
      },
      {
        resourceScope: 'get_backed',
        resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
      }
    )

    expect(parsed.tables.map((table) => table.tableName)).toEqual([
      'customers',
      'tax_calculations',
      'v2_core_account_persons',
      'v2_core_events',
    ])
    expect(parsed.tables.find((table) => table.tableName === 'customers')?.sourcePaths).toEqual([
      '/v1/customers/{customer}',
    ])
    expect(
      parsed.tables.find((table) => table.tableName === 'tax_calculations')?.sourcePaths
    ).toEqual(['/v1/tax/calculations/{calculation}'])
    expect(
      parsed.tables.find((table) => table.tableName === 'v2_core_account_persons')?.sourcePaths
    ).toEqual(['/v2/core/accounts/{account_id}/persons'])
    expect(parsed.tables.find((table) => table.tableName === 'v2_core_events')?.sourcePaths).toEqual(
      ['/v2/core/events']
    )
  })

  it('response_backed scope includes retrieve-only, post-only, deleted, and v2 resources', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        openapi: '3.0.0',
        info: { version: '2026-02-25' },
        paths: {
          '/v1/ephemeral_keys': {
            post: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: { $ref: '#/components/schemas/ephemeral_key' },
                    },
                  },
                },
              },
            },
          },
          '/v1/customers/{customer}': {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        anyOf: [
                          { $ref: '#/components/schemas/customer' },
                          { $ref: '#/components/schemas/deleted_customer' },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
          '/v2/core/account_links': {
            post: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: { $ref: '#/components/schemas/v2.core.account_link' },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            customer: {
              'x-resourceId': 'customer',
              type: 'object',
              properties: {
                id: { type: 'string' },
                deleted: { type: 'boolean' },
              },
            },
            deleted_customer: {
              'x-resourceId': 'deleted_customer',
              type: 'object',
              properties: {
                id: { type: 'string' },
                deleted: { type: 'boolean' },
              },
            },
            ephemeral_key: {
              'x-resourceId': 'ephemeral_key',
              type: 'object',
              properties: {
                id: { type: 'string' },
                secret: { type: 'string' },
              },
            },
            'v2.core.account_link': {
              'x-resourceId': 'v2.core.account_link',
              type: 'object',
              properties: {
                id: { type: 'string' },
                object: { type: 'string' },
              },
            },
          },
        },
      },
      {
        resourceScope: 'response_backed',
        resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
      }
    )

    expect(parsed.tables.map((table) => table.tableName)).toEqual([
      'customers',
      'deleted_customers',
      'ephemeral_keys',
      'v2_core_account_links',
    ])
    expect(parsed.tables.find((table) => table.tableName === 'customers')?.sourcePaths).toEqual([
      '/v1/customers/{customer}',
    ])
    expect(
      parsed.tables.find((table) => table.tableName === 'deleted_customers')?.sourcePaths
    ).toEqual(['/v1/customers/{customer}'])
    expect(
      parsed.tables.find((table) => table.tableName === 'ephemeral_keys')?.sourcePaths
    ).toEqual(['/v1/ephemeral_keys'])
    expect(
      parsed.tables.find((table) => table.tableName === 'v2_core_account_links')?.sourcePaths
    ).toEqual(['/v2/core/account_links'])
  })

  it('resource_id_backed scope includes every x-resourceId schema and annotates x-stripeOperations paths', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        openapi: '3.0.0',
        info: { version: '2026-02-25' },
        paths: {},
        components: {
          schemas: {
            customer: {
              'x-resourceId': 'customer',
              'x-stripeOperations': [
                {
                  method_name: 'list',
                  method_type: 'list',
                  operation: 'get',
                  path: '/v1/customers',
                },
              ],
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
            ephemeral_key: {
              'x-resourceId': 'ephemeral_key',
              type: 'object',
              properties: {
                id: { type: 'string' },
                secret: { type: 'string' },
              },
            },
            'v2.core.account_person': {
              'x-resourceId': 'v2.core.account_person',
              'x-stripeOperations': [
                {
                  method_name: 'list',
                  method_type: 'list',
                  operation: 'get',
                  path: '/v2/core/accounts/{account_id}/persons',
                },
              ],
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
          },
        },
      },
      {
        resourceScope: 'resource_id_backed',
        resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
      }
    )

    expect(parsed.tables.map((table) => table.tableName)).toEqual([
      'customers',
      'ephemeral_keys',
      'v2_core_account_persons',
    ])
    expect(parsed.tables.find((table) => table.tableName === 'customers')?.sourcePaths).toEqual([
      '/v1/customers',
    ])
    expect(
      parsed.tables.find((table) => table.tableName === 'v2_core_account_persons')?.sourcePaths
    ).toEqual(['/v2/core/accounts/{account_id}/persons'])
    expect(
      parsed.tables.find((table) => table.tableName === 'ephemeral_keys')?.sourcePaths
    ).toEqual([])
  })

  it('all_projected expands beyond runtime_required on the real Stripe 2020-08-27 spec', async () => {
    const apiVersion = '2020-08-27'
    const resolvedSpec = await resolveOpenApiSpec({
      apiVersion,
    })

    const parser = new SpecParser()
    const runtimeParsed = parser.parse(resolvedSpec.spec, {
      allowedTables: [...RUNTIME_REQUIRED_TABLES],
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })
    const allProjectedParsed = parser.parse(resolvedSpec.spec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })

    expect(runtimeParsed.tables.map((table) => table.tableName)).toEqual(
      [...RUNTIME_REQUIRED_TABLES].sort()
    )
    expect(allProjectedParsed.tables.length).toBeGreaterThan(runtimeParsed.tables.length)
    expect(allProjectedParsed.tables.length).toBe(70)
    expect(
      allProjectedParsed.tables.some((table) => !RUNTIME_REQUIRED_TABLES.includes(table.tableName))
    ).toBe(true)
    expect(allProjectedParsed.tables.some((table) => table.tableName.startsWith('deleted_'))).toBe(
      false
    )
    expect(allProjectedParsed.tables.some((table) => table.tableName === 'ephemeral_keys')).toBe(
      false
    )
  }, 60000) // 60 second timeout for fetching real spec

  it('the real Stripe 2025-01-27 spec remains v1-only in collection-backed mode', async () => {
    const apiVersion = '2025-01-27'
    const resolvedSpec = await resolveOpenApiSpec({
      apiVersion,
    })

    const parser = new SpecParser()
    const collectionParsed = parser.parse(resolvedSpec.spec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })
    const resourceIds = collectionParsed.tables.flatMap((table) =>
      (table.resourceIds ?? [table.resourceId]).filter(
        (resourceId): resourceId is string => typeof resourceId === 'string'
      )
    )

    expect(collectionParsed.tables.length).toBe(107)
    expect(collectionParsed.tables.some((table) => table.tableName.startsWith('v2_'))).toBe(false)
    expect(resourceIds.some((resourceId) => resourceId.startsWith('v2.'))).toBe(false)
  }, 60000)

  it('get_backed recovers real GET resources that rely on SDK metadata fallback', async () => {
    const apiVersion = '2024-06-20'
    const resolvedSpec = await resolveOpenApiSpec({
      apiVersion,
    })

    const parser = new SpecParser()
    const getBackedParsed = parser.parse(resolvedSpec.spec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
      resourceScope: 'get_backed',
    })

    expect(getBackedParsed.tables.some((table) => table.tableName === 'tax_calculations')).toBe(
      true
    )
  }, 60000)

  it('get_backed sits between collection_backed and response_backed on the real 2026-02-24 spec', async () => {
    const apiVersion = '2026-02-24'
    const resolvedSpec = await resolveOpenApiSpec({
      apiVersion,
    })

    const parser = new SpecParser()
    const collectionParsed = parser.parse(resolvedSpec.spec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })
    const getBackedParsed = parser.parse(resolvedSpec.spec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
      resourceScope: 'get_backed',
    })
    const responseParsed = parser.parse(resolvedSpec.spec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
      resourceScope: 'response_backed',
    })

    expect(getBackedParsed.tables.length).toBeGreaterThan(collectionParsed.tables.length)
    expect(getBackedParsed.tables.length).toBeLessThan(responseParsed.tables.length)
    expect(getBackedParsed.tables.some((table) => table.tableName === 'deleted_customers')).toBe(
      false
    )
    expect(getBackedParsed.tables.some((table) => table.tableName === 'ephemeral_keys')).toBe(false)
    expect(getBackedParsed.tables.some((table) => table.tableName === 'v2_core_account_links')).toBe(
      false
    )
    expect(getBackedParsed.tables.some((table) => table.tableName === 'v2_core_events')).toBe(
      true
    )
  }, 60000)

  it('response_backed matches the broader Stripe 2026-02-24 object inventory', async () => {
    const apiVersion = '2026-02-24'
    const resolvedSpec = await resolveOpenApiSpec({
      apiVersion,
    })

    const parser = new SpecParser()
    const collectionParsed = parser.parse(resolvedSpec.spec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })
    const responseParsed = parser.parse(resolvedSpec.spec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
      resourceScope: 'response_backed',
    })

    expect(collectionParsed.tables.length).toBe(113)
    expect(responseParsed.tables.length).toBe(174)
    expect(responseParsed.tables.length).toBeGreaterThan(collectionParsed.tables.length)

    expect(responseParsed.tables.some((table) => table.tableName === 'ephemeral_keys')).toBe(true)
    expect(responseParsed.tables.some((table) => table.tableName === 'deleted_customers')).toBe(true)
    expect(responseParsed.tables.some((table) => table.tableName === 'v2_core_account_links')).toBe(
      true
    )

    const v2Tables = responseParsed.tables.filter((table) =>
      (table.resourceIds ?? [table.resourceId]).some((resourceId) => resourceId.startsWith('v2.'))
    )
    const deletedTables = responseParsed.tables.filter((table) =>
      (table.resourceIds ?? [table.resourceId]).some((resourceId) =>
        resourceId.startsWith('deleted_')
      )
    )

    expect(v2Tables.length).toBe(10)
    expect(deletedTables.length).toBe(22)
  }, 60000)
})
