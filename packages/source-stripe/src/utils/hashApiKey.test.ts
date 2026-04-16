import { describe, expect, it } from 'vitest'
import { hashApiKey } from './hashApiKey.js'

describe('hashApiKey', () => {
  it('returns a 64-character hex string (SHA-256)', () => {
    const hash = hashApiKey('sk_test_abc123')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for the same input', () => {
    expect(hashApiKey('sk_test_abc')).toBe(hashApiKey('sk_test_abc'))
  })

  it('produces different hashes for different keys', () => {
    expect(hashApiKey('sk_test_aaa')).not.toBe(hashApiKey('sk_test_bbb'))
  })

  it('produces the expected SHA-256 hash', () => {
    // echo -n "sk_test_known" | sha256sum
    const expected = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    // verify the empty string hash matches node:crypto output
    expect(hashApiKey('')).toBe(expected)
  })
})
