import createClient from 'openapi-fetch'
import type { paths } from './openapi.js'
import type { Engine } from './engine.js'
import { parseNdjsonStream, toNdjsonStream } from './ndjson.js'
import type { CheckResult, DestinationOutput, Message, PipelineConfig } from '@stripe/sync-protocol'

/**
 * HTTP client that satisfies the Engine interface by delegating each method to
 * the corresponding sync engine REST endpoint. Backed by openapi-fetch with
 * types generated from docs/openapi/engine.json.
 *
 * Usage:
 *   const engine = createRemoteEngine('http://localhost:3001', pipeline)
 *   await engine.setup()
 *   for await (const msg of engine.sync()) { ... }
 */
export function createRemoteEngine(engineUrl: string, pipeline: PipelineConfig): Engine {
  // Typed client provides compile-time safety on path strings and header names.
  const client = createClient<paths>({ baseUrl: engineUrl })
  const ph = JSON.stringify(pipeline)

  /**
   * Execute a streaming POST (read / write / sync).
   * Uses raw fetch instead of openapi-fetch because openapi-fetch's default bodySerializer
   * calls JSON.stringify on the ReadableStream body (producing '{}'), which corrupts the
   * NDJSON stream. Raw fetch passes the ReadableStream through unchanged.
   */
  async function streamPost(
    path: '/read' | '/write' | '/sync',
    body?: ReadableStream<Uint8Array>
  ): Promise<Response> {
    const headers: Record<string, string> = { 'x-pipeline': ph }
    if (body) headers['content-type'] = 'application/x-ndjson'
    const res = await fetch(`${engineUrl}${path}`, {
      method: 'POST',
      headers,
      body,
      // Node 18+ requires duplex:'half' when the request body is a ReadableStream
      ...(body ? ({ duplex: 'half' } as Record<string, unknown>) : {}),
    } as RequestInit)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Engine ${path} failed (${res.status}): ${text}`)
    }
    return res
  }

  return {
    async setup() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { response } = await (client.POST as any)('/setup', {
        params: { header: { 'x-pipeline': ph } },
        parseAs: 'stream',
      })
      const res = response as Response
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Engine /setup failed (${res.status}): ${text}`)
      }
    },

    async teardown() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { response } = await (client.POST as any)('/teardown', {
        params: { header: { 'x-pipeline': ph } },
        parseAs: 'stream',
      })
      const res = response as Response
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Engine /teardown failed (${res.status}): ${text}`)
      }
    },

    async check() {
      const { data, error } = await client.GET('/check', {
        params: { header: { 'x-pipeline': ph } },
      })
      if (error) throw new Error(`Engine /check failed: ${JSON.stringify(error)}`)
      return data as { source: CheckResult; destination: CheckResult }
    },

    async *read(input?: AsyncIterable<unknown>) {
      const body = input ? toNdjsonStream(input) : undefined
      const res = await streamPost('/read', body)
      yield* parseNdjsonStream<Message>(res.body!)
    },

    async *write(messages: AsyncIterable<Message>) {
      const res = await streamPost('/write', toNdjsonStream(messages))
      yield* parseNdjsonStream<DestinationOutput>(res.body!)
    },

    async *sync(input?: AsyncIterable<unknown>) {
      const body = input ? toNdjsonStream(input) : undefined
      const res = await streamPost('/sync', body)
      yield* parseNdjsonStream<DestinationOutput>(res.body!)
    },
  }
}
