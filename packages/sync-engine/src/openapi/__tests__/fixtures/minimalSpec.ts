import type { OpenApiSpec, OpenApiPathItem } from '../../types'

function listPath(schemaRef: string): OpenApiPathItem {
  return {
    get: {
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  object: { type: 'string', enum: ['list'] },
                  data: { type: 'array', items: { $ref: `#/components/schemas/${schemaRef}` } },
                  has_more: { type: 'boolean' },
                  url: { type: 'string' },
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
    '/v1/customers': listPath('customer'),
    '/v1/plans': listPath('plan'),
    '/v1/prices': listPath('price'),
    '/v1/products': listPath('product'),
    '/v1/subscription_items': listPath('subscription_item'),
    '/v1/checkout/sessions': listPath('checkout_session'),
    '/v1/radar/early_fraud_warnings': listPath('early_fraud_warning'),
    '/v1/entitlements/active_entitlements': listPath('active_entitlement'),
    '/v1/entitlements/features': listPath('entitlements_feature'),
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
