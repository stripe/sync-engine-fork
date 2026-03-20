import type { OpenApiPathItemObject, OpenApiSpec } from '../../types'

function listPath(schemaRef: string): OpenApiPathItemObject {
  return {
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
                    items: { $ref: schemaRef },
                  },
                },
              },
            },
          },
        },
      },
    },
  }
}

export const minimalStripeOpenApiSpec: OpenApiSpec = {
  openapi: '3.0.0',
  info: {
    version: '2020-08-27',
  },
  paths: {
    '/v1/checkout/sessions': listPath('#/components/schemas/checkout_session'),
    '/v1/checkout/sessions/{checkout_session}': {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/checkout_session' },
              },
            },
          },
        },
      },
    },
    '/v1/customers': listPath('#/components/schemas/customer'),
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
    '/v1/entitlements/active_entitlements': listPath('#/components/schemas/active_entitlement'),
    '/v1/entitlements/active_entitlements/{id}': {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/active_entitlement' },
              },
            },
          },
        },
      },
    },
    '/v1/entitlements/features': listPath('#/components/schemas/entitlements_feature'),
    '/v1/entitlements/features/{id}': {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/entitlements_feature' },
              },
            },
          },
        },
      },
    },
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
    } as OpenApiPathItemObject,
    '/v1/plans': listPath('#/components/schemas/plan'),
    '/v1/prices': listPath('#/components/schemas/price'),
    '/v1/prices/{price}': {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/price' },
              },
            },
          },
        },
      },
    },
    '/v1/products': listPath('#/components/schemas/product'),
    '/v1/products/{product}': {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/product' },
              },
            },
          },
        },
      },
    },
    '/v1/radar/early_fraud_warnings': listPath('#/components/schemas/early_fraud_warning'),
    '/v1/radar/early_fraud_warnings/{early_fraud_warning}': {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/early_fraud_warning' },
              },
            },
          },
        },
      },
    },
    '/v1/subscription_items': listPath('#/components/schemas/subscription_item'),
    '/v1/subscription_items/{item}': {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/subscription_item' },
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
        oneOf: [
          {
            type: 'object',
            properties: {
              id: { type: 'string' },
              object: { type: 'string' },
              created: { type: 'integer' },
            },
          },
          {
            type: 'object',
            properties: {
              id: { type: 'string' },
              deleted: { type: 'boolean' },
            },
          },
        ],
      },
      deleted_customer: {
        'x-resourceId': 'deleted_customer',
        type: 'object',
        properties: {
          id: { type: 'string' },
          object: { type: 'string' },
          deleted: { type: 'boolean', enum: [true] },
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
      plan: {
        'x-resourceId': 'plan',
        type: 'object',
        properties: {
          id: { type: 'string' },
          active: { type: 'boolean' },
          amount: { type: 'integer' },
        },
      },
      price: {
        'x-resourceId': 'price',
        type: 'object',
        properties: {
          id: { type: 'string' },
          product: { type: 'string' },
          unit_amount: { type: 'integer' },
          metadata: { type: 'object', additionalProperties: true },
        },
      },
      product: {
        'x-resourceId': 'product',
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
      },
      subscription_item: {
        'x-resourceId': 'subscription_item',
        type: 'object',
        properties: {
          id: { type: 'string' },
          deleted: { type: 'boolean' },
          subscription: { type: 'string' },
          quantity: { type: 'integer' },
        },
      },
      checkout_session: {
        'x-resourceId': 'checkout.session',
        type: 'object',
        properties: {
          id: { type: 'string' },
          amount_total: { type: 'integer' },
          customer: { type: 'string', nullable: true },
        },
      },
      early_fraud_warning: {
        'x-resourceId': 'radar.early_fraud_warning',
        type: 'object',
        properties: {
          id: { type: 'string' },
          charge: { type: 'string' },
        },
      },
      active_entitlement: {
        'x-resourceId': 'entitlements.active_entitlement',
        type: 'object',
        properties: {
          id: { type: 'string' },
          customer: { type: 'string' },
          feature: { type: 'string' },
        },
      },
      entitlements_feature: {
        'x-resourceId': 'entitlements.feature',
        type: 'object',
        properties: {
          id: { type: 'string' },
          lookup_key: { type: 'string' },
        },
      },
    },
  },
}
