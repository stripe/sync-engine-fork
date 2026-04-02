import createClient from 'openapi-fetch'
import type { paths } from './openapi.js'
import type { Engine } from './engine.js'
import { parseNdjsonStream, toNdjsonStream } from './ndjson.js'
import type { CheckResult, DestinationOutput, Message, PipelineConfig } from '@stripe/sync-protocol'

/**
 * HTTP client that satisfies the Engine interface by delegating each method to
 * the corresponding sync engine REST endpoint.
 *
 * Uses openapi-fetch for typed JSON endpoints (/check, /connectors).
 * Streaming NDJSON endpoints use plain fetch — openapi-fetch's type system
 * doesn't model ReadableStream bodies or `parseAs: 'stream'` well.
 *
 * Usage:
 *   const engine = createRemoteEngine('http://localhost:3001', pipeline)
 *   await engine.setup()
 *   for await (const msg of engine.sync()) { ... }
 */
export function createRemoteEngine(
  engineUrl: string,
  pipeline: PipelineConfig,
  opts?: { state?: Record<string, unknown>; stateLimit?: number }
): Engine {
  const client = createClient<paths>({ baseUrl: engineUrl })
  const pipelineHeader = JSON.stringify(pipeline)

  /** POST with optional streaming NDJSON body. Returns the raw Response. */
  async function post(path: string, body?: ReadableStream<Uint8Array>): Promise<Response> {
    const headers: Record<string, string> = { 'x-pipeline': pipelineHeader }

    if (opts?.state && Object.keys(opts.state).length > 0) {
      headers['x-state'] = JSON.stringify(opts.state)
    }
    if (opts?.stateLimit != null) {
      headers['x-state-checkpoint-limit'] = String(opts.stateLimit)
    }

    const init: RequestInit & { duplex?: string } = { method: 'POST', headers }

    if (body) {
      headers['content-type'] = 'application/x-ndjson'
      init.body = body
      init.duplex = 'half' // Required by Node 18+ for ReadableStream bodies
    }

    const res = await fetch(`${engineUrl}${path}`, init)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Engine ${path} failed (${res.status}): ${text}`)
    }
    return res
  }

  return {
    async setup() {
      await post('/setup')
    },

    async teardown() {
      await post('/teardown')
    },

    async check() {
      const { data, error } = await client.GET('/check', {
        params: { header: { 'x-pipeline': pipelineHeader } },
      })
      if (error) throw new Error(`Engine /check failed: ${JSON.stringify(error)}`)
      return data as { source: CheckResult; destination: CheckResult }
    },

    async *read(input?: AsyncIterable<unknown>) {
      const body = input ? toNdjsonStream(input) : undefined
      const res = await post('/read', body)
      yield* parseNdjsonStream<Message>(res.body!)
    },

    async *write(messages: AsyncIterable<Message>) {
      const res = await post('/write', toNdjsonStream(messages))
      yield* parseNdjsonStream<DestinationOutput>(res.body!)
    },

    async *sync(input?: AsyncIterable<unknown>) {
      const body = input ? toNdjsonStream(input) : undefined
      const res = await post('/sync', body)
      yield* parseNdjsonStream<DestinationOutput>(res.body!)
    },
  }
}
