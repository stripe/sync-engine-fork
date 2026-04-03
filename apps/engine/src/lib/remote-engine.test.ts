import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import type { ConnectorResolver, Message } from './index.js'
import { sourceTest, destinationTest } from './index.js'
import { createApp } from '../api/app.js'
import { createRemoteEngine } from './remote-engine.js'
import type { PipelineConfig } from '@stripe/sync-protocol'

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const resolver: ConnectorResolver = {
  resolveSource: async (name) => {
    if (name !== 'test') throw new Error(`Unknown source connector: ${name}`)
    return sourceTest
  },
  resolveDestination: async (name) => {
    if (name !== 'test') throw new Error(`Unknown destination connector: ${name}`)
    return destinationTest
  },
  sources: () =>
    new Map([
      [
        'test',
        {
          connector: sourceTest,
          configSchema: {} as any,
          rawConfigJsonSchema: sourceTest.spec().config,
        },
      ],
    ]),
  destinations: () =>
    new Map([
      [
        'test',
        {
          connector: destinationTest,
          configSchema: {} as any,
          rawConfigJsonSchema: destinationTest.spec().config,
        },
      ],
    ]),
}

vi.spyOn(console, 'info').mockImplementation(() => undefined)
vi.spyOn(console, 'error').mockImplementation(() => undefined)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any
let engineUrl: string

const pipeline: PipelineConfig = {
  source: { type: 'test', streams: { customers: {} } },
  destination: { type: 'test' },
}

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      const app = createApp(resolver)
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        engineUrl = `http://localhost:${(info as AddressInfo).port}`
        resolve()
      })
    })
)

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((err: Error | null) => (err ? reject(err) : resolve()))
    })
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iter) items.push(item)
  return items
}

async function* asIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRemoteEngine', () => {
  describe('setup()', () => {
    it('resolves without error', async () => {
      const engine = createRemoteEngine(engineUrl)
      await expect(engine.pipelineSetup(pipeline)).resolves.toEqual({})
    })
  })

  describe('teardown()', () => {
    it('resolves without error', async () => {
      const engine = createRemoteEngine(engineUrl)
      await expect(engine.pipelineTeardown(pipeline)).resolves.toBeUndefined()
    })
  })

  describe('check()', () => {
    it('returns source and destination check results', async () => {
      const engine = createRemoteEngine(engineUrl)
      const result = await engine.pipelineCheck(pipeline)
      expect(result).toEqual({
        source: { status: 'succeeded' },
        destination: { status: 'succeeded' },
      })
    })
  })

  describe('read()', () => {
    it('streams messages from input iterable', async () => {
      const engine = createRemoteEngine(engineUrl)
      const input: Message[] = [
        {
          type: 'record',
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
        { type: 'state', stream: 'customers', data: { cursor: 'cus_1' } },
      ]
      const messages = await collect(engine.pipelineRead(pipeline, undefined, asIterable(input)))
      expect(messages).toHaveLength(3)
      expect(messages[0]!.type).toBe('record')
      expect(messages[1]!.type).toBe('state')
      expect(messages[2]).toMatchObject({ type: 'eof', reason: 'complete' })
    })

    it('returns eof:complete when called without input', async () => {
      const engine = createRemoteEngine(engineUrl)
      // sourceTest yields nothing when $stdin is absent — only eof
      const messages = await collect(engine.pipelineRead(pipeline))
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ type: 'eof', reason: 'complete' })
    })
  })

  describe('write()', () => {
    it('yields only state messages (destinationTest behaviour)', async () => {
      const engine = createRemoteEngine(engineUrl)
      const messages: Message[] = [
        {
          type: 'record',
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
        { type: 'state', stream: 'customers', data: { cursor: 'cus_1' } },
      ]
      const output = await collect(engine.pipelineWrite(pipeline, asIterable(messages)))
      expect(output).toHaveLength(1)
      expect(output[0]!.type).toBe('state')
      expect((output[0] as { stream: string }).stream).toBe('customers')
    })
  })

  describe('sync()', () => {
    it('runs full pipeline and yields state messages', async () => {
      const engine = createRemoteEngine(engineUrl)
      const input: Message[] = [
        {
          type: 'record',
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
        { type: 'state', stream: 'customers', data: { cursor: 'cus_1' } },
      ]
      const output = await collect(engine.pipelineSync(pipeline, undefined, asIterable(input)))
      expect(output).toHaveLength(2)
      expect(output[0]!.type).toBe('state')
      expect(output[1]).toMatchObject({ type: 'eof', reason: 'complete' })
    })

    it('returns eof:complete without input (no source data)', async () => {
      const engine = createRemoteEngine(engineUrl)
      const output = await collect(engine.pipelineSync(pipeline))
      expect(output).toHaveLength(1)
      expect(output[0]).toMatchObject({ type: 'eof', reason: 'complete' })
    })
  })

  describe('listConnectors()', () => {
    it('returns available sources and destinations', async () => {
      const engine = createRemoteEngine(engineUrl)
      const result = await engine.connectorList()
      expect(result.sources).toHaveProperty('test')
      expect(result.destinations).toHaveProperty('test')
      expect(result.sources['test']).toHaveProperty('config_schema')
    })
  })

  describe('error handling', () => {
    it('throws on HTTP errors (nonexistent connector)', async () => {
      const badPipeline: PipelineConfig = {
        source: { type: 'nonexistent' },
        destination: { type: 'nonexistent' },
      }
      const engine = createRemoteEngine(engineUrl)
      await expect(engine.pipelineSetup(badPipeline)).rejects.toThrow(/failed/)
    })
  })
})
