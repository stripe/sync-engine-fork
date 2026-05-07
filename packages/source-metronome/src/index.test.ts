import { describe, expect, it, vi } from 'vitest'
import type { ConfiguredCatalog, Message } from '@stripe/sync-protocol'
import source from './index.js'
import { resources } from './resources.js'

async function collectAll<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = []
  for await (const item of iter) results.push(item)
  return results
}

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const TEST_CONFIG = { api_key: 'test-bearer-token' }

const CUSTOMERS_CATALOG: ConfiguredCatalog = {
  streams: [
    {
      stream: {
        name: 'customers',
        primary_key: [['id']],
        newer_than_field: '_synced_at',
        json_schema: {},
      },
      sync_mode: 'full_refresh',
      destination_sync_mode: 'append_dedup',
    },
  ],
}

describe('source-metronome', () => {
  describe('spec()', () => {
    it('yields a spec message with config JSON schema', async () => {
      const messages = await collectAll(source.spec())
      expect(messages).toHaveLength(1)
      const [msg] = messages
      expect(msg.type).toBe('spec')
      if (msg.type !== 'spec') throw new Error('expected spec')
      expect(msg.spec.config).toBeDefined()
      expect(typeof msg.spec.config).toBe('object')
      expect(msg.spec.source_state_stream).toBeDefined()
    })
  })

  describe('discover()', () => {
    it('yields a catalog with all expected stream names', async () => {
      const messages = await collectAll(source.discover({ config: TEST_CONFIG }))
      expect(messages).toHaveLength(1)
      const [msg] = messages
      expect(msg.type).toBe('catalog')
      if (msg.type !== 'catalog') throw new Error('expected catalog')
      const streamNames = msg.catalog.streams.map((s) => s.name)
      for (const resource of resources) {
        expect(streamNames).toContain(resource.name)
      }
    })
  })

  describe('check()', () => {
    it('yields connection_status succeeded when API responds 200', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(makeResponse({ data: [], next_page: null }))

      vi.stubGlobal('fetch', fetchMock)
      try {
        const messages = await collectAll(
          source.check({ config: { ...TEST_CONFIG, base_url: 'http://metronome.test' } })
        )
        expect(messages).toHaveLength(1)
        const [msg] = messages
        expect(msg.type).toBe('connection_status')
        if (msg.type !== 'connection_status') throw new Error('expected connection_status')
        expect(msg.connection_status.status).toBe('succeeded')
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('yields connection_status failed when API returns an error', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(makeResponse({ error: 'Unauthorized' }, 401))

      vi.stubGlobal('fetch', fetchMock)
      try {
        const messages = await collectAll(
          source.check({ config: { ...TEST_CONFIG, base_url: 'http://metronome.test' } })
        )
        expect(messages).toHaveLength(1)
        const [msg] = messages
        expect(msg.type).toBe('connection_status')
        if (msg.type !== 'connection_status') throw new Error('expected connection_status')
        expect(msg.connection_status.status).toBe('failed')
        expect(msg.connection_status.message).toContain('401')
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })

  describe('read()', () => {
    it('yields the correct message sequence: started, records, source_state, complete', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
        makeResponse({
          data: [
            { id: 'cus_1', name: 'Acme Corp', external_id: 'ext_1' },
            { id: 'cus_2', name: 'Globex', external_id: 'ext_2' },
          ],
          next_page: null,
        })
      )

      vi.stubGlobal('fetch', fetchMock)
      try {
        const messages = (await collectAll(
          source.read({ config: TEST_CONFIG, catalog: CUSTOMERS_CATALOG })
        )) as Message[]

        // stream_status: start
        const startMsg = messages.find(
          (m) => m.type === 'stream_status' && m.stream_status.status === 'start'
        )
        expect(startMsg).toBeDefined()

        // records
        const records = messages.filter((m) => m.type === 'record')
        expect(records).toHaveLength(2)
        if (records[0].type !== 'record') throw new Error('expected record')
        expect(records[0].record.stream).toBe('customers')
        expect(records[0].record.data).toMatchObject({ id: 'cus_1', name: 'Acme Corp' })
        expect(typeof records[0].record.data['_synced_at']).toBe('number')

        // source_state checkpoint
        const stateMessages = messages.filter((m) => m.type === 'source_state')
        expect(stateMessages.length).toBeGreaterThanOrEqual(1)

        // stream_status: complete
        const completeMsg = messages.find(
          (m) => m.type === 'stream_status' && m.stream_status.status === 'complete'
        )
        expect(completeMsg).toBeDefined()

        // order: start before complete
        const startIdx = messages.indexOf(startMsg!)
        const completeIdx = messages.indexOf(completeMsg!)
        expect(startIdx).toBeLessThan(completeIdx)
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('only syncs streams in the configured catalog', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(makeResponse({ data: [{ id: 'plan_1', name: 'Pro' }], next_page: null }))

      vi.stubGlobal('fetch', fetchMock)
      try {
        const plansCatalog: ConfiguredCatalog = {
          streams: [
            {
              stream: {
                name: 'plans',
                primary_key: [['id']],
                newer_than_field: '_synced_at',
                json_schema: {},
              },
              sync_mode: 'full_refresh',
              destination_sync_mode: 'append_dedup',
            },
          ],
        }

        const messages = (await collectAll(
          source.read({ config: TEST_CONFIG, catalog: plansCatalog })
        )) as Message[]

        const recordStreams = new Set(
          messages
            .filter((m): m is Extract<Message, { type: 'record' }> => m.type === 'record')
            .map((m) => m.record.stream)
        )
        expect(recordStreams).toEqual(new Set(['plans']))
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('resumes from a stored cursor via startCursor', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          makeResponse({ data: [{ id: 'cus_3', name: 'NewCo' }], next_page: null })
        )

      vi.stubGlobal('fetch', fetchMock)
      try {
        await collectAll(
          source.read({
            config: TEST_CONFIG,
            catalog: CUSTOMERS_CATALOG,
            state: {
              streams: { customers: { next_page: 'resume_cursor_xyz' } },
              global: {},
            },
          })
        )

        // The fetch URL should include the resume cursor
        const [url] = fetchMock.mock.calls[0]
        expect(url as string).toContain('next_page=resume_cursor_xyz')
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('emits stream_status error when API throws', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(makeResponse({ error: 'Internal Server Error' }, 500))

      vi.stubGlobal('fetch', fetchMock)
      try {
        const messages = (await collectAll(
          source.read({ config: TEST_CONFIG, catalog: CUSTOMERS_CATALOG })
        )) as Message[]

        const errorMsg = messages.find(
          (m) => m.type === 'stream_status' && m.stream_status.status === 'error'
        )
        expect(errorMsg).toBeDefined()
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })
})
