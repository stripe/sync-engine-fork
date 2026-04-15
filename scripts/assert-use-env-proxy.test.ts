import { describe, it, expect } from 'bun:test'
import { assertUseEnvProxy } from './assert-use-env-proxy.js'

const PROXY_ENV = { HTTPS_PROXY: 'http://proxy.example.test:8080' }

describe('assertUseEnvProxy', () => {
  it('does not throw when no proxy is configured', () => {
    expect(() => assertUseEnvProxy({}, [])).not.toThrow()
  })

  it('does not throw when proxy is set and --use-env-proxy is in execArgv', () => {
    expect(() => assertUseEnvProxy(PROXY_ENV, ['--use-env-proxy'])).not.toThrow()
  })

  it('does not throw when proxy is set and --use-env-proxy is in NODE_OPTIONS', () => {
    expect(() =>
      assertUseEnvProxy({ ...PROXY_ENV, NODE_OPTIONS: '--use-env-proxy' }, [])
    ).not.toThrow()
  })

  it('does not throw when NODE_OPTIONS has multiple flags including --use-env-proxy', () => {
    expect(() =>
      assertUseEnvProxy(
        { ...PROXY_ENV, NODE_OPTIONS: '--max-old-space-size=4096 --use-env-proxy' },
        []
      )
    ).not.toThrow()
  })

  it('throws when proxy is set but --use-env-proxy is absent', () => {
    expect(() => assertUseEnvProxy(PROXY_ENV, [])).toThrow(/--use-env-proxy/)
  })

  it('throws when proxy is set via lowercase http_proxy and --use-env-proxy is absent', () => {
    expect(() =>
      assertUseEnvProxy({ http_proxy: 'http://proxy.example.test:8080' }, [])
    ).toThrow(/--use-env-proxy/)
  })

  it('includes the proxy URL in the error message', () => {
    expect(() => assertUseEnvProxy(PROXY_ENV, [])).toThrow('http://proxy.example.test:8080')
  })
})
