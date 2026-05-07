import { describe, it, expect } from 'vitest'
import { configSchema } from './spec.js'
import { buildRecordKey } from './index.js'
import destination from './index.js'

describe('destination-redis', () => {
  describe('config validation', () => {
    it('accepts url-only config', () => {
      const result = configSchema.safeParse({ url: 'redis://localhost:6379' })
      expect(result.success).toBe(true)
    })

    it('accepts host/port config', () => {
      const result = configSchema.safeParse({ host: 'localhost', port: 6379 })
      expect(result.success).toBe(true)
    })

    it('rejects both url and host', () => {
      const result = configSchema.safeParse({ url: 'redis://localhost:6379', host: 'localhost' })
      expect(result.success).toBe(false)
    })

    it('rejects both url and port', () => {
      const result = configSchema.safeParse({ url: 'redis://localhost:6379', port: 6379 })
      expect(result.success).toBe(false)
    })

    it('defaults batch_size to 100', () => {
      const result = configSchema.safeParse({})
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.batch_size).toBe(100)
      }
    })

    it('accepts full config', () => {
      const result = configSchema.safeParse({
        host: 'redis.example.com',
        port: 6380,
        password: 'secret',
        db: 1,
        tls: true,
        key_prefix: 'myapp:',
        batch_size: 50,
      })
      expect(result.success).toBe(true)
    })
  })

  describe('buildRecordKey', () => {
    it('builds single-column key', () => {
      expect(buildRecordKey('sync:', 'customers', ['id'], { id: 'cust_123', name: 'Alice' })).toBe(
        'sync:customers:cust_123'
      )
    })

    it('builds composite key', () => {
      expect(
        buildRecordKey('sync:', 'entitlements', ['account_id', 'created'], {
          account_id: 'acct_1',
          created: 1000,
        })
      ).toBe('sync:entitlements:acct_1:1000')
    })

    it('handles missing key column with empty string', () => {
      expect(buildRecordKey('', 'items', ['id'], { name: 'Alice' })).toBe('items:')
    })

    it('handles empty prefix', () => {
      expect(buildRecordKey('', 'customers', ['id'], { id: 'cust_1' })).toBe('customers:cust_1')
    })
  })

  describe('spec()', () => {
    it('yields a spec message with config schema', async () => {
      const msgs: unknown[] = []
      for await (const msg of destination.spec()) {
        msgs.push(msg)
      }
      expect(msgs).toHaveLength(1)
      const msg = msgs[0] as { type: string; spec: { config: unknown } }
      expect(msg.type).toBe('spec')
      expect(msg.spec).toHaveProperty('config')
    })
  })
})
