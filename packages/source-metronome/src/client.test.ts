import { describe, expect, it, vi } from 'vitest'
import { MetronomeClient } from './client.js'

function makeResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

describe('MetronomeClient', () => {
  describe('paginate', () => {
    it('stops after a single page when next_page is null', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          makeResponse({ data: [{ id: 'cus_1' }, { id: 'cus_2' }], next_page: null })
        )

      const client = new MetronomeClient({ apiKey: 'test-key', fetch: fetchMock })
      const pages: unknown[][] = []
      for await (const page of client.paginate('GET', '/v1/customers')) {
        pages.push(page.data)
      }

      expect(pages).toHaveLength(1)
      expect(pages[0]).toHaveLength(2)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('follows next_page cursor across multiple pages', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(makeResponse({ data: [{ id: 'cus_1' }], next_page: 'cursor_abc' }))
        .mockResolvedValueOnce(makeResponse({ data: [{ id: 'cus_2' }], next_page: null }))

      const client = new MetronomeClient({ apiKey: 'test-key', fetch: fetchMock })
      const allRecords: unknown[] = []
      for await (const page of client.paginate('GET', '/v1/customers')) {
        allRecords.push(...page.data)
      }

      expect(allRecords).toHaveLength(2)
      expect(fetchMock).toHaveBeenCalledTimes(2)

      // Second call should include next_page in query params
      const secondCall = fetchMock.mock.calls[1]
      expect(secondCall[0]).toContain('next_page=cursor_abc')
    })

    it('uses POST body for POST pagination', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(makeResponse({ data: [{ id: 'contract_1' }], next_page: null }))

      const client = new MetronomeClient({ apiKey: 'test-key', fetch: fetchMock })
      const pages: unknown[][] = []
      for await (const page of client.paginate('POST', '/v1/contracts/list', {
        customer_id: 'cus_1',
      })) {
        pages.push(page.data)
      }

      expect(pages).toHaveLength(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toContain('/v1/contracts/list')
      expect(init?.method).toBe('POST')
      const body = JSON.parse(init?.body as string)
      expect(body).toMatchObject({ customer_id: 'cus_1', limit: 100 })
    })
  })

  describe('retry logic', () => {
    it('retries on 429 and eventually succeeds', async () => {
      vi.useFakeTimers()
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(makeResponse({ error: 'rate limited' }, 429, { 'retry-after': '0' }))
        .mockResolvedValueOnce(makeResponse({ id: 'cus_1', name: 'Test' }))

      const client = new MetronomeClient({ apiKey: 'test-key', fetch: fetchMock })
      const pending = client.get('/v1/customers/cus_1')
      await vi.runAllTimersAsync()
      const result = await pending

      expect(result).toEqual({ id: 'cus_1', name: 'Test' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it('throws immediately on non-retryable 400 error', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(makeResponse({ error: 'bad request' }, 400))

      const client = new MetronomeClient({ apiKey: 'test-key', fetch: fetchMock })
      await expect(client.get('/v1/customers/bad')).rejects.toThrow('Metronome API 400')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('includes Authorization header on all requests', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(makeResponse({ data: [], next_page: null }))

      const client = new MetronomeClient({ apiKey: 'my-secret-key', fetch: fetchMock })
      await client.get('/v1/customers')

      const [, init] = fetchMock.mock.calls[0]
      expect((init?.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer my-secret-key'
      )
    })
  })
})
