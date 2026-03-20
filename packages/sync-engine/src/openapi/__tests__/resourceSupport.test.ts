import { describe, expect, it } from 'vitest'
import { buildResourceSupportProfiles } from '../resourceSupport'
import type { OpenApiSpec } from '../types'
import { resolveOpenApiSpec } from '../specFetchHelper'

describe('buildResourceSupportProfiles', () => {
  it('requires exactly one canonical /v1 or /v2 list path for backfill support', () => {
    const spec: OpenApiSpec = {
      openapi: '3.0.0',
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
          refund: {
            'x-resourceId': 'refund',
            'x-stripeOperations': [
              {
                method_name: 'list',
                method_type: 'list',
                operation: 'get',
                path: '/v1/refunds',
              },
              {
                method_name: 'list',
                method_type: 'list',
                operation: 'get',
                path: '/v1/charges/{charge}/refunds',
              },
            ],
            type: 'object',
            properties: {
              id: { type: 'string' },
            },
          },
          file_link: {
            'x-resourceId': 'file_link',
            'x-stripeOperations': [
              {
                method_name: 'list',
                method_type: 'list',
                operation: 'get',
                path: '/files',
              },
            ],
            type: 'object',
            properties: {
              id: { type: 'string' },
            },
          },
        },
      },
    }

    const profiles = buildResourceSupportProfiles(spec)

    expect(profiles.get('customer')).toMatchObject({
      hasListEndpoint: true,
      supportsBackfill: true,
      listOperationCount: 2,
      listPathCount: 1,
      canonicalListPath: '/v1/customers',
    })
    expect(profiles.get('refund')).toMatchObject({
      hasListEndpoint: false,
      supportsBackfill: false,
      listOperationCount: 2,
      listPathCount: 2,
    })
    expect(profiles.get('file_link')).toMatchObject({
      hasListEndpoint: false,
      supportsBackfill: false,
      listOperationCount: 1,
      listPathCount: 1,
      canonicalListPath: '/files',
    })
  })

  it('maps webhook targets from object refs, object anyOf refs, and related_object.type enums', () => {
    const spec: OpenApiSpec = {
      openapi: '3.0.0',
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
          deleted_customer: {
            'x-resourceId': 'deleted_customer',
            type: 'object',
            properties: {
              id: { type: 'string' },
              deleted: { type: 'boolean' },
            },
          },
          'v2.core.account': {
            'x-resourceId': 'v2.core.account',
            'x-stripeOperations': [
              {
                method_name: 'list',
                method_type: 'list',
                operation: 'get',
                path: '/v2/core/accounts',
              },
            ],
            type: 'object',
            properties: {
              id: { type: 'string' },
            },
          },
          'customer.created': {
            'x-stripeEvent': {
              type: 'customer.created',
            },
            type: 'object',
            properties: {
              object: {
                $ref: '#/components/schemas/customer',
              },
            },
          },
          'customer.updated': {
            'x-stripeEvent': {
              type: 'customer.updated',
            },
            type: 'object',
            properties: {
              object: {
                anyOf: [
                  { $ref: '#/components/schemas/customer' },
                  { $ref: '#/components/schemas/deleted_customer' },
                ],
              },
            },
          },
          'v2.core.account.updated': {
            'x-stripeEvent': {
              kind: 'thin',
              type: 'v2.core.account.updated',
            },
            type: 'object',
            properties: {
              related_object: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: ['v2.core.account'],
                  },
                },
              },
            },
          },
        },
      },
    }

    const profiles = buildResourceSupportProfiles(spec)

    expect(profiles.get('customer')).toMatchObject({
      hasWebhookEvent: true,
      supportsRealtime: true,
      webhookEventTypes: ['customer.created', 'customer.updated'],
      isDeployable: true,
    })
    expect(profiles.get('deleted_customer')).toMatchObject({
      hasWebhookEvent: true,
      supportsRealtime: true,
      webhookEventTypes: ['customer.updated'],
      isDeployable: false,
    })
    expect(profiles.get('v2.core.account')).toMatchObject({
      hasWebhookEvent: true,
      supportsRealtime: true,
      webhookEventTypes: ['v2.core.account.updated'],
      isDeployable: true,
    })
  })

  it('marks the real 2026-02-24 persons/account resources with the expected support flags', async () => {
    const resolved = await resolveOpenApiSpec({ apiVersion: '2026-02-24' })
    const profiles = buildResourceSupportProfiles(resolved.spec)

    expect(profiles.get('v2.core.account_person')).toMatchObject({
      hasListEndpoint: true,
      hasWebhookEvent: true,
      isDeployable: true,
      canonicalListPath: '/v2/core/accounts/{account_id}/persons',
    })
    expect(profiles.get('v2.core.account')).toMatchObject({
      hasListEndpoint: true,
      hasWebhookEvent: true,
      isDeployable: true,
      canonicalListPath: '/v2/core/accounts',
    })
    expect(profiles.get('v2.core.event')).toMatchObject({
      hasListEndpoint: true,
      hasWebhookEvent: false,
      isDeployable: false,
      canonicalListPath: '/v2/core/events',
    })
  }, 60000)

  it('matches the full real 2026-02-24 v2 resource support inventory', async () => {
    const resolved = await resolveOpenApiSpec({ apiVersion: '2026-02-24' })
    const profiles = buildResourceSupportProfiles(resolved.spec)

    const v2Profiles = Array.from(profiles.values())
      .filter((profile) => profile.resourceId.startsWith('v2.'))
      .sort((left, right) => left.resourceId.localeCompare(right.resourceId))
      .map((profile) => ({
        resourceId: profile.resourceId,
        hasListEndpoint: profile.hasListEndpoint,
        hasWebhookEvent: profile.hasWebhookEvent,
        isDeployable: profile.isDeployable,
      }))

    expect(v2Profiles).toEqual([
      {
        resourceId: 'v2.billing.meter_event',
        hasListEndpoint: false,
        hasWebhookEvent: false,
        isDeployable: false,
      },
      {
        resourceId: 'v2.billing.meter_event_adjustment',
        hasListEndpoint: false,
        hasWebhookEvent: false,
        isDeployable: false,
      },
      {
        resourceId: 'v2.billing.meter_event_session',
        hasListEndpoint: false,
        hasWebhookEvent: false,
        isDeployable: false,
      },
      {
        resourceId: 'v2.core.account',
        hasListEndpoint: true,
        hasWebhookEvent: true,
        isDeployable: true,
      },
      {
        resourceId: 'v2.core.account_link',
        hasListEndpoint: false,
        hasWebhookEvent: false,
        isDeployable: false,
      },
      {
        resourceId: 'v2.core.account_person',
        hasListEndpoint: true,
        hasWebhookEvent: true,
        isDeployable: true,
      },
      {
        resourceId: 'v2.core.account_person_token',
        hasListEndpoint: false,
        hasWebhookEvent: false,
        isDeployable: false,
      },
      {
        resourceId: 'v2.core.account_token',
        hasListEndpoint: false,
        hasWebhookEvent: false,
        isDeployable: false,
      },
      {
        resourceId: 'v2.core.event',
        hasListEndpoint: true,
        hasWebhookEvent: false,
        isDeployable: false,
      },
      {
        resourceId: 'v2.core.event_destination',
        hasListEndpoint: true,
        hasWebhookEvent: true,
        isDeployable: true,
      },
    ])
  }, 60000)

  it('finds no v2 resource support profiles in the real 2025-01-27 spec', async () => {
    const resolved = await resolveOpenApiSpec({ apiVersion: '2025-01-27' })
    const profiles = buildResourceSupportProfiles(resolved.spec)

    expect(
      Array.from(profiles.values()).some((profile) => profile.resourceId.startsWith('v2.'))
    ).toBe(false)
  }, 60000)
})
