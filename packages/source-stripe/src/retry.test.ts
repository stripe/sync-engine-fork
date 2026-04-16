import { describe, expect, it, vi } from 'vitest'
import { getHttpErrorStatus, isRetryableHttpError, withHttpRetry } from './retry.js'

describe('getHttpErrorStatus', () => {
  it('returns undefined for non-objects', () => {
    expect(getHttpErrorStatus(null)).toBeUndefined()
    expect(getHttpErrorStatus('error')).toBeUndefined()
    expect(getHttpErrorStatus(42)).toBeUndefined()
  })

  it('reads .status', () => {
    expect(getHttpErrorStatus({ status: 429 })).toBe(429)
  })

  it('reads .statusCode', () => {
    expect(getHttpErrorStatus({ statusCode: 500 })).toBe(500)
  })

  it('reads .code when numeric', () => {
    expect(getHttpErrorStatus({ code: 503 })).toBe(503)
  })

  it('prefers .status over .statusCode', () => {
    expect(getHttpErrorStatus({ status: 429, statusCode: 503 })).toBe(429)
  })

  it('ignores string codes', () => {
    expect(getHttpErrorStatus({ code: 'ECONNRESET' })).toBeUndefined()
  })
})

describe('isRetryableHttpError', () => {
  it('retries on 429', () => {
    expect(isRetryableHttpError({ status: 429 })).toBe(true)
  })

  it('retries on 500+', () => {
    expect(isRetryableHttpError({ status: 500 })).toBe(true)
    expect(isRetryableHttpError({ status: 503 })).toBe(true)
  })

  it('does not retry on 4xx client errors', () => {
    expect(isRetryableHttpError({ status: 400 })).toBe(false)
    expect(isRetryableHttpError({ status: 401 })).toBe(false)
    expect(isRetryableHttpError({ status: 404 })).toBe(false)
  })

  it('retries on TimeoutError', () => {
    const err = new Error('timeout')
    err.name = 'TimeoutError'
    expect(isRetryableHttpError(err)).toBe(true)
  })

  it('does not retry on AbortError', () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    expect(isRetryableHttpError(err)).toBe(false)
  })

  it('retries on retryable network error codes', () => {
    const err = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
    expect(isRetryableHttpError(err)).toBe(true)
  })

  it('retries on nested cause with network code', () => {
    const cause = Object.assign(new Error('inner'), { code: 'ETIMEDOUT' })
    const err = Object.assign(new Error('outer'), { cause })
    expect(isRetryableHttpError(err)).toBe(true)
  })

  it('retries on messages containing "fetch failed"', () => {
    expect(isRetryableHttpError(new Error('fetch failed'))).toBe(true)
  })

  it('retries on messages containing "timeout"', () => {
    expect(isRetryableHttpError(new Error('request timeout'))).toBe(true)
  })

  it('does not retry on unrelated errors', () => {
    expect(isRetryableHttpError(new Error('some random error'))).toBe(false)
  })
})

describe('withHttpRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withHttpRetry(fn, { baseDelayMs: 0 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on retryable error then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValue('done')
    const result = await withHttpRetry(fn, { baseDelayMs: 0 })
    expect(result).toBe('done')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('throws immediately on non-retryable error', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 400 })
    await expect(withHttpRetry(fn, { baseDelayMs: 0 })).rejects.toEqual({ status: 400 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('throws after maxRetries exhausted', async () => {
    const err = { status: 500 }
    const fn = vi.fn().mockRejectedValue(err)
    await expect(withHttpRetry(fn, { maxRetries: 2, baseDelayMs: 0 })).rejects.toEqual(err)
    expect(fn).toHaveBeenCalledTimes(3) // initial + 2 retries
  })

  it('throws if signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('aborted'))
    const fn = vi.fn().mockResolvedValue('ok')
    await expect(withHttpRetry(fn, { signal: controller.signal })).rejects.toThrow()
    expect(fn).not.toHaveBeenCalled()
  })
})
