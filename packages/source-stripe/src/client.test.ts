import { describe, expect, it } from 'vitest'
import { buildTransportOptions, makeClientConfig, type StripeClientConfigInput } from './client.js'
import { getProxyUrl } from './transport.js'

const config: StripeClientConfigInput = {
  api_key: 'sk_test_fake',
}

describe('getProxyUrl', () => {
  it('prefers HTTPS_PROXY over HTTP_PROXY', () => {
    expect(
      getProxyUrl({
        HTTPS_PROXY: 'http://secure-proxy.example.test:8080',
        HTTP_PROXY: 'http://fallback-proxy.example.test:8080',
      })
    ).toBe('http://secure-proxy.example.test:8080')
  })

  it('returns undefined when no proxy env var is set', () => {
    expect(getProxyUrl({})).toBeUndefined()
  })
})

describe('buildTransportOptions', () => {
  it('returns default timeout and api.stripe.com base when no overrides', () => {
    const options = buildTransportOptions(config, {})

    expect(options.timeout_ms).toBe(10_000)
    expect(options.base_url).toBe('https://api.stripe.com')
    expect(options.host).toBe('api.stripe.com')
    expect(options.port).toBe(443)
    expect(options.protocol).toBe('https')
  })

  it('uses the configured timeout override', () => {
    const options = buildTransportOptions(config, {
      STRIPE_REQUEST_TIMEOUT_MS: '2500',
    })

    expect(options.timeout_ms).toBe(2500)
  })

  it('decomposes a localhost base_url', () => {
    const options = buildTransportOptions({ ...config, base_url: 'http://localhost:12111' }, {})

    expect(options.host).toBe('localhost')
    expect(options.port).toBe(12111)
    expect(options.protocol).toBe('http')
  })

  it('throws on an invalid timeout override', () => {
    expect(() =>
      buildTransportOptions(config, {
        STRIPE_REQUEST_TIMEOUT_MS: '0',
      })
    ).toThrow('STRIPE_REQUEST_TIMEOUT_MS must be a positive integer')
  })
})

describe('makeClientConfig', () => {
  it('maps snake_case input to camelCase StripeClientConfig', () => {
    const result = makeClientConfig({
      api_key: 'sk_test_123',
      base_url: 'http://localhost:12111',
    })

    expect(result).toEqual({
      apiKey: 'sk_test_123',
      baseUrl: 'http://localhost:12111',
    })
  })

  it('omits baseUrl when base_url is not provided', () => {
    const result = makeClientConfig({ api_key: 'sk_test_123' })

    expect(result).toEqual({
      apiKey: 'sk_test_123',
      baseUrl: undefined,
    })
  })
})
