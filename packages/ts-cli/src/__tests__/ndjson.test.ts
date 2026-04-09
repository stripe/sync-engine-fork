import { describe, expect, it, vi } from 'vitest'
import { ndjsonResponse } from '../ndjson.js'

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

/** Yields items slowly, tracking how many were pulled via the callback. */
async function* slowItems(count: number, onYield: () => void): AsyncIterable<{ n: number }> {
  for (let i = 0; i < count; i++) {
    await new Promise((r) => setTimeout(r, 10))
    onYield()
    yield { n: i }
  }
}

async function readLines(res: Response): Promise<unknown[]> {
  const text = await res.text()
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

describe('ndjsonResponse', () => {
  it('streams items as NDJSON lines', async () => {
    const res = ndjsonResponse(fromArray([{ a: 1 }, { b: 2 }]))
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')
    const lines = await readLines(res)
    expect(lines).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('calls onError callback with the thrown error and emits the result', async () => {
    async function* failing(): AsyncIterable<{ type: string; msg?: string }> {
      yield { type: 'ok' }
      throw new Error('kaboom')
    }
    const res = ndjsonResponse(failing(), (err) => ({
      type: 'error',
      msg: err instanceof Error ? err.message : 'unknown',
    }))
    const lines = await readLines(res)
    expect(lines).toEqual([{ type: 'ok' }, { type: 'error', msg: 'kaboom' }])
  })

  it('silently closes the stream when no onError is provided and iterable throws', async () => {
    async function* failing(): AsyncIterable<{ type: string }> {
      yield { type: 'ok' }
      throw new Error('kaboom')
    }
    const res = ndjsonResponse(failing())
    const lines = await readLines(res)
    // Only the item before the error — no error message emitted
    expect(lines).toEqual([{ type: 'ok' }])
  })

  it('stops pulling from the iterable when the stream is cancelled', async () => {
    let yielded = 0
    const res = ndjsonResponse(slowItems(100, () => yielded++))

    const reader = res.body!.getReader()
    // Read a couple of chunks to let the generator start
    await reader.read()
    await reader.read()

    // Cancel simulates client disconnect
    await reader.cancel()

    const yieldedAtCancel = yielded
    // Wait to confirm no more items are pulled
    await new Promise((r) => setTimeout(r, 100))
    expect(yielded).toBeLessThan(100)
    // Should not have pulled significantly more after cancel
    expect(yielded - yieldedAtCancel).toBeLessThanOrEqual(1)
  })
})
