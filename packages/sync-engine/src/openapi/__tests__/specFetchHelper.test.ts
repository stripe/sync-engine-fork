import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveOpenApiSpec } from '../specFetchHelper'
import { minimalStripeOpenApiSpec } from './fixtures/minimalSpec'

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`))
}

describe('resolveOpenApiSpec', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('prefers explicit local spec path over cache and network', async () => {
    const tempDir = await createTempDir('openapi-explicit')
    const specPath = path.join(tempDir, 'spec3.json')
    await fs.writeFile(specPath, JSON.stringify(minimalStripeOpenApiSpec), 'utf8')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveOpenApiSpec({
      apiVersion: '2020-08-27',
      openApiSpecPath: specPath,
      cacheDir: tempDir,
    })

    expect(result.source).toBe('explicit_path')
    expect(fetchMock).not.toHaveBeenCalled()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('uses cache by api version when available', async () => {
    const tempDir = await createTempDir('openapi-cache')
    const cachePath = path.join(tempDir, '2020-08-27.spec3.json')
    const sdkCachePath = path.join(tempDir, '2020-08-27.openapi.spec3.sdk.json')
    await fs.writeFile(cachePath, JSON.stringify(minimalStripeOpenApiSpec), 'utf8')
    await fs.writeFile(sdkCachePath, JSON.stringify(minimalStripeOpenApiSpec), 'utf8')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveOpenApiSpec({
      apiVersion: '2020-08-27',
      cacheDir: tempDir,
    })

    expect(result.source).toBe('cache')
    expect(result.cachePath).toBe(cachePath)
    expect(fetchMock).not.toHaveBeenCalled()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('fetches from GitHub when cache misses and persists cache', async () => {
    const tempDir = await createTempDir('openapi-fetch')
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input)
      if (url.includes('/commits')) {
        return new Response(JSON.stringify([{ sha: 'abc123def456' }]), { status: 200 })
      }
      return new Response(JSON.stringify(minimalStripeOpenApiSpec), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveOpenApiSpec({
      apiVersion: '2020-08-27',
      cacheDir: tempDir,
    })

    expect(result.source).toBe('github')
    expect(result.commitSha).toBe('abc123def456')

    const cached = await fs.readFile(path.join(tempDir, '2020-08-27.spec3.json'), 'utf8')
    expect(JSON.parse(cached)).toMatchObject({ openapi: '3.0.0' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('merges v2 SDK paths and schemas into resolved specs when available', async () => {
    const tempDir = await createTempDir('openapi-v2-merge')
    const v2SdkSpec = {
      openapi: '3.0.0',
      info: {
        version: '2026-02-25',
      },
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
            },
          },
        },
      },
    }
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input)
      if (url.includes('/commits') && url.includes('path=openapi%2Fspec3.json')) {
        return new Response(JSON.stringify([{ sha: 'publicv1sha' }]), { status: 200 })
      }
      if (url.includes('/commits') && url.includes('path=latest%2Fopenapi.sdk.spec3.json')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/commits') && url.includes('path=latest%2Fopenapi.spec3.sdk.json')) {
        return new Response(JSON.stringify([{ sha: 'unifiedv2sha' }]), { status: 200 })
      }
      if (url.includes('/commits') && url.includes('path=openapi%2Fspec3.sdk.json')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/publicv1sha/openapi/spec3.json')) {
        return new Response(JSON.stringify(minimalStripeOpenApiSpec), { status: 200 })
      }
      if (url.includes('/unifiedv2sha/latest/openapi.spec3.sdk.json')) {
        return new Response(JSON.stringify(v2SdkSpec), { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveOpenApiSpec({
      apiVersion: '2026-02-25',
      cacheDir: tempDir,
    })

    expect(result.source).toBe('github')
    expect(result.spec.paths).toHaveProperty('/v1/plans')
    expect(result.spec.paths).toHaveProperty('/v2/core/accounts')
    expect(result.spec.components?.schemas?.['v2.core.account']).toBeDefined()
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('path=latest%2Fopenapi.sdk.spec3.json')
      )
    ).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(6)
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('supports the original unified SDK filename introduced with 2026-01-28', async () => {
    const tempDir = await createTempDir('openapi-v2-original-unified-name')
    const publicSpec = {
      ...minimalStripeOpenApiSpec,
      info: { version: '2026-01-28' },
      components: {
        schemas: {
          customer: {
            'x-resourceId': 'customer',
            type: 'object',
            properties: {
              id: { type: 'string' },
            },
          },
        },
      },
    }
    const legacySdkSpec = {
      openapi: '3.0.0',
      info: {
        version: '2026-01-28',
      },
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
        },
      },
    }
    const originalUnifiedSpec = {
      openapi: '3.0.0',
      info: {
        version: '2026-01-28',
      },
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
            },
          },
        },
      },
    }
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input)
      if (url.includes('/commits') && url.includes('path=openapi%2Fspec3.json')) {
        return new Response(JSON.stringify([{ sha: 'publicv1sha' }]), { status: 200 })
      }
      if (url.includes('/commits') && url.includes('path=latest%2Fopenapi.sdk.spec3.json')) {
        return new Response(JSON.stringify([{ sha: 'originalunifiedsha' }]), { status: 200 })
      }
      if (url.includes('/commits') && url.includes('path=latest%2Fopenapi.spec3.sdk.json')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/commits') && url.includes('path=openapi%2Fspec3.sdk.json')) {
        return new Response(JSON.stringify([{ sha: 'legacysdksha' }]), { status: 200 })
      }
      if (url.includes('/publicv1sha/openapi/spec3.json')) {
        return new Response(JSON.stringify(publicSpec), { status: 200 })
      }
      if (url.includes('/originalunifiedsha/latest/openapi.sdk.spec3.json')) {
        return new Response(JSON.stringify(originalUnifiedSpec), { status: 200 })
      }
      if (url.includes('/legacysdksha/openapi/spec3.sdk.json')) {
        return new Response(JSON.stringify(legacySdkSpec), { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveOpenApiSpec({
      apiVersion: '2026-01-28',
      cacheDir: tempDir,
    })

    expect(result.source).toBe('github')
    expect(result.spec.paths).toHaveProperty('/v2/core/accounts')
    expect(result.spec.components?.schemas?.['v2.core.account']).toBeDefined()
    expect(result.spec.components?.schemas?.customer).toMatchObject({
      'x-stripeOperations': [
        expect.objectContaining({
          method_name: 'list',
          path: '/v1/customers',
        }),
      ],
    })
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('path=latest%2Fopenapi.sdk.spec3.json')
      )
    ).toBe(true)
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('merges SDK metadata for older API versions when legacy SDK artifacts exist', async () => {
    const tempDir = await createTempDir('openapi-legacy-sdk')
    const publicSpec = {
      ...minimalStripeOpenApiSpec,
      info: { version: '2022-08-01' },
      components: {
        schemas: {
          customer: {
            'x-resourceId': 'customer',
            type: 'object',
            properties: {
              id: { type: 'string' },
            },
          },
        },
      },
    }
    const legacySdkSpec = {
      openapi: '3.0.0',
      info: {
        version: '2022-08-01',
      },
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
        },
      },
    }
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input)
      if (url.includes('/commits') && url.includes('path=openapi%2Fspec3.json')) {
        return new Response(JSON.stringify([{ sha: 'publicv1sha' }]), { status: 200 })
      }
      if (url.includes('/commits') && url.includes('path=openapi%2Fspec3.sdk.json')) {
        return new Response(JSON.stringify([{ sha: 'legacysdksha' }]), { status: 200 })
      }
      if (url.includes('/publicv1sha/openapi/spec3.json')) {
        return new Response(JSON.stringify(publicSpec), { status: 200 })
      }
      if (url.includes('/legacysdksha/openapi/spec3.sdk.json')) {
        return new Response(JSON.stringify(legacySdkSpec), { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveOpenApiSpec({
      apiVersion: '2022-08-01',
      cacheDir: tempDir,
    })

    expect(result.source).toBe('github')
    expect(result.spec.components?.schemas?.customer).toMatchObject({
      'x-resourceId': 'customer',
      'x-stripeOperations': [
        expect.objectContaining({
          method_name: 'list',
          path: '/v1/customers',
        }),
      ],
    })
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('path=latest%2Fopenapi.spec3.sdk.json')
      )
    ).toBe(false)
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('preserves top-level SDK metadata on shared v1 schemas', async () => {
    const tempDir = await createTempDir('openapi-v1-sdk-metadata')
    const publicSpec = {
      ...minimalStripeOpenApiSpec,
      info: { version: '2026-02-25' },
      components: {
        schemas: {
          customer: {
            'x-resourceId': 'customer',
            type: 'object',
            properties: {
              id: { type: 'string' },
            },
          },
        },
      },
    }
    const v2SdkSpec = {
      openapi: '3.0.0',
      info: {
        version: '2026-02-25',
      },
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
        },
      },
    }
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input)
      if (url.includes('/commits') && url.includes('path=openapi%2Fspec3.json')) {
        return new Response(JSON.stringify([{ sha: 'publicv1sha' }]), { status: 200 })
      }
      if (url.includes('/commits') && url.includes('path=latest%2Fopenapi.sdk.spec3.json')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/commits') && url.includes('path=latest%2Fopenapi.spec3.sdk.json')) {
        return new Response(JSON.stringify([{ sha: 'unifiedv2sha' }]), { status: 200 })
      }
      if (url.includes('/commits') && url.includes('path=openapi%2Fspec3.sdk.json')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/publicv1sha/openapi/spec3.json')) {
        return new Response(JSON.stringify(publicSpec), { status: 200 })
      }
      if (url.includes('/unifiedv2sha/latest/openapi.spec3.sdk.json')) {
        return new Response(JSON.stringify(v2SdkSpec), { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveOpenApiSpec({
      apiVersion: '2026-02-25',
      cacheDir: tempDir,
    })

    expect(result.spec.components?.schemas?.customer).toMatchObject({
      'x-resourceId': 'customer',
      'x-stripeOperations': [
        expect.objectContaining({
          method_name: 'list',
          path: '/v1/customers',
        }),
      ],
    })
    expect(result.spec.components?.schemas?.['customer.created']).toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(6)
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('throws for malformed explicit spec files', async () => {
    const tempDir = await createTempDir('openapi-malformed')
    const specPath = path.join(tempDir, 'spec3.json')
    await fs.writeFile(specPath, JSON.stringify({ openapi: '3.0.0' }), 'utf8')

    await expect(
      resolveOpenApiSpec({
        apiVersion: '2020-08-27',
        openApiSpecPath: specPath,
      })
    ).rejects.toThrow(/components|schemas/i)
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('falls back to public spec for older versions when SDK artifacts are unavailable', async () => {
    const tempDir = await createTempDir('openapi-sdk-fallback')
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input)
      if (url.includes('/commits') && url.includes('path=openapi%2Fspec3.json')) {
        return new Response(JSON.stringify([{ sha: 'publicv1sha' }]), { status: 200 })
      }
      if (
        url.includes('/commits') &&
        (url.includes('path=openapi%2Fspec3.sdk.json') ||
          url.includes('path=latest%2Fopenapi.sdk.spec3.json') ||
          url.includes('path=latest%2Fopenapi.spec3.sdk.json'))
      ) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/publicv1sha/openapi/spec3.json')) {
        return new Response(JSON.stringify(minimalStripeOpenApiSpec), { status: 200 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveOpenApiSpec({
      apiVersion: '2022-08-01',
      cacheDir: tempDir,
    })

    expect(result.source).toBe('github')
    expect(result.spec.paths).toMatchObject(minimalStripeOpenApiSpec.paths ?? {})
    expect(result.spec.components?.schemas?.customer).not.toHaveProperty('x-stripeOperations')
    expect(fetchMock).toHaveBeenCalledTimes(5)
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('does not fail when optional SDK lookup errors for older versions', async () => {
    const tempDir = await createTempDir('openapi-sdk-network-fallback')
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input)
      if (url.includes('/commits') && url.includes('path=openapi%2Fspec3.json')) {
        return new Response(JSON.stringify([{ sha: 'publicv1sha' }]), { status: 200 })
      }
      if (url.includes('/publicv1sha/openapi/spec3.json')) {
        return new Response(JSON.stringify(minimalStripeOpenApiSpec), { status: 200 })
      }
      if (
        url.includes('/commits') &&
        (url.includes('path=openapi%2Fspec3.sdk.json') ||
          url.includes('path=latest%2Fopenapi.sdk.spec3.json') ||
          url.includes('path=latest%2Fopenapi.spec3.sdk.json'))
      ) {
        throw new Error('temporary SDK lookup outage')
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveOpenApiSpec({
      apiVersion: '2022-08-01',
      cacheDir: tempDir,
    })

    expect(result.source).toBe('github')
    expect(result.spec.paths).toMatchObject(minimalStripeOpenApiSpec.paths ?? {})
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('fails fast when GitHub resolution fails and no explicit spec path is set', async () => {
    const tempDir = await createTempDir('openapi-fail-fast')
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      resolveOpenApiSpec({
        apiVersion: '2020-08-27',
        cacheDir: tempDir,
      })
    ).rejects.toThrow(/Failed to resolve Stripe OpenAPI commit/)
    await fs.rm(tempDir, { recursive: true, force: true })
  })
})
