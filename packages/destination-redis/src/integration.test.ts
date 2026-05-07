import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Redis } from 'ioredis'
import destination from './index.js'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:56379'

/** Collect all items from an async iterable */
async function collectAll<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = []
  for await (const item of iter) results.push(item)
  return results
}

// Detect Redis availability at module level (synchronous probe)
let available = false
try {
  const r = new Redis(REDIS_URL, { lazyConnect: true, connectTimeout: 1000 })
  await r.connect()
  await r.ping()
  available = true
  await r.quit()
} catch {
  available = false
}

describe.skipIf(!available)('destination-redis integration', () => {
  const config = { url: REDIS_URL, key_prefix: 'test_sync:', batch_size: 2 }
  const catalog = {
    streams: [
      {
        stream: {
          name: 'customers',
          primary_key: [['id']],
          newer_than_field: '_synced_at',
          json_schema: {},
        },
        sync_mode: 'full_refresh' as const,
        destination_sync_mode: 'append_dedup' as const,
      },
    ],
  }

  afterAll(async () => {
    const r = new Redis(REDIS_URL)
    const keys = await r.keys('test_sync:*')
    if (keys.length > 0) await r.del(...keys)
    await r.quit()
  })

  it('check succeeds with valid connection', async () => {
    const msgs = await collectAll(destination.check({ config }))
    expect(msgs).toEqual([
      { type: 'connection_status', connection_status: { status: 'succeeded' } },
    ])
  })

  it('writes records to Redis hash', async () => {
    async function* input() {
      yield {
        type: 'record' as const,
        record: {
          stream: 'customers',
          data: { id: 'cust_1', name: 'Alice', _synced_at: 1000 },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      }
      yield {
        type: 'record' as const,
        record: {
          stream: 'customers',
          data: { id: 'cust_2', name: 'Bob', _synced_at: 1001 },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      }
      yield {
        type: 'source_state' as const,
        source_state: { state_type: 'stream' as const, stream: 'customers', data: {} },
      }
    }

    await collectAll(destination.write({ config, catalog }, input()))

    const r = new Redis(REDIS_URL)
    const val1 = await r.get('test_sync:customers:cust_1')
    const val2 = await r.get('test_sync:customers:cust_2')
    expect(JSON.parse(val1!)).toMatchObject({ id: 'cust_1', name: 'Alice' })
    expect(JSON.parse(val2!)).toMatchObject({ id: 'cust_2', name: 'Bob' })
    await r.quit()
  })

  it('teardown deletes prefixed keys', async () => {
    const r = new Redis(REDIS_URL)
    await r.set('test_sync:teardown_test:key1', 'val1')
    await r.quit()

    await collectAll(destination.teardown!({ config }))

    const r2 = new Redis(REDIS_URL)
    const keys = await r2.keys('test_sync:*')
    expect(keys).toHaveLength(0)
    await r2.quit()
  })
})
