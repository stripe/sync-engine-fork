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
 */
export function ndjsonResponse<T>(
  iterable: AsyncIterable<T>,
  opts?: { onError?: (err: unknown) => T; signal?: AbortSignal }
): Response {
  const encoder = new TextEncoder()
  const ac = new AbortController()

  // Link external signal (e.g. request abort on client disconnect) to our controller
  if (opts?.signal) {
    if (opts.signal.aborted) {
      ac.abort()
    } else {
      opts.signal.addEventListener('abort', () => ac.abort(), { once: true })
    }
  }

  const aborted = new Promise<never>((_, reject) => {
    ac.signal.addEventListener(
      'abort',
      () => reject(new DOMException('The operation was aborted', 'AbortError')),
      { once: true }
    )
  })

  const stream = new ReadableStream({
    async start(controller) {
      const iterator = iterable[Symbol.asyncIterator]()
      try {
        while (true) {
          const { value, done } = await Promise.race([iterator.next(), aborted])
          if (done) break
          controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'))
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError') && opts?.onError) {
          controller.enqueue(encoder.encode(JSON.stringify(opts.onError(err)) + '\n'))
        }
      } finally {
        // Tear down the generator chain
        await iterator.return?.()
        try {
          controller.close()
        } catch {
          // Already closed by cancel — ignore
        }
      }
    },
    cancel() {
      ac.abort()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
    },
  })
}
