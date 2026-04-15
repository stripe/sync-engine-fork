import * as readline from 'node:readline'

/** Read NDJSON lines from stdin. */
export async function* readStdin(): AsyncIterable<unknown> {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (line.trim()) yield JSON.parse(line)
  }
}

/** Write a single NDJSON line to stdout. */
export function writeLine(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

/** Wrap an AsyncIterable into an NDJSON streaming Response (application/x-ndjson).
 *
 * If `onError` is provided, uncaught errors are mapped to a final message of
 * type `T` before closing the stream. The callback must return a valid `T` —
 * this keeps protocol-specific error shapes out of this generic helper.
 *
 * If `onCancel` is provided it is called when the ReadableStream is cancelled
 * (e.g. client disconnect under Bun.serve()). Cancellation also calls
 * `iterator.return()` on the wrapped iterable so normal async-iterator teardown
 * can propagate upstream.
 */
export function ndjsonResponse<T>(
  iterable: AsyncIterable<T>,
  opts?:
    | ((err: unknown) => T)
    | {
        onError?: (err: unknown) => T
        onCancel?: () => void
        signal?: AbortSignal
      }
): Response {
  const onError = typeof opts === 'function' ? opts : opts?.onError
  const onCancel = typeof opts === 'object' ? opts?.onCancel : undefined
  const signal = typeof opts === 'object' ? opts?.signal : undefined

  const encoder = new TextEncoder()
  const iterator = iterable[Symbol.asyncIterator]()
  const stop = async () => {
    await iterator.return?.()
  }

  const stream = new ReadableStream({
    async start(controller) {
      if (signal) {
        if (signal.aborted) {
          await stop()
          controller.close()
          return
        }
        signal.addEventListener('abort', () => {
          void stop()
        }, { once: true })
      }
      try {
        while (true) {
          const { done, value } = await iterator.next()
          if (done) break
          const item = value
          controller.enqueue(encoder.encode(JSON.stringify(item) + '\n'))
        }
      } catch (err) {
        if (onError) {
          controller.enqueue(encoder.encode(JSON.stringify(onError(err)) + '\n'))
        }
      } finally {
        controller.close()
      }
    },
    async cancel() {
      onCancel?.()
      await stop()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
    },
  })
}
