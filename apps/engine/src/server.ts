import { logger } from './logger.js'

const KB = 1024
const MB = 1024 * KB

// Pipeline config and connector state are passed via HTTP headers.
// Node.js defaults to 16 KB which is too small for resumed syncs that carry
// both X-Pipeline and X-State.
const MAX_HEADER_SIZE = 50 * MB

/**
 * Start the engine HTTP server, picking Bun.serve() when available and
 * falling back to @hono/node-server on Node.js / tsx.
 *
 * Bun.serve() properly cancels ReadableStreams on client disconnect.
 * The Node path applies ENGINE_SERVER_OPTIONS (50 MB maxHeaderSize)
 * so that large X-Pipeline / X-State headers are accepted.
 *
 * Bun ignores per-server maxHeaderSize — the limit must be set globally
 * via `bun --max-http-header-size=<bytes>`. Throws at startup if it's
 * still at the 16 KB default.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function startServer(app: { fetch: (...args: any[]) => any }, port: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (globalThis as any).Bun !== 'undefined') {
    const http = await import('node:http')
    if (http.maxHeaderSize < MAX_HEADER_SIZE) {
      throw new Error(
        `Bun ignores per-server maxHeaderSize (current: ${http.maxHeaderSize}, required: ${MAX_HEADER_SIZE}). ` +
          `Run with: bun --max-http-header-size=${MAX_HEADER_SIZE}`
      )
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).Bun.serve({ fetch: app.fetch, port, idleTimeout: 60 })
    logger.info({ port, server: 'Bun.serve' }, `Sync Engine listening on http://localhost:${port}`)
  } else {
    const { serve } = await import('@hono/node-server')
    serve({ fetch: app.fetch, port, serverOptions: { maxHeaderSize: MAX_HEADER_SIZE } }, (info) => {
      logger.info(
        { port: info.port },
        `Sync Engine listening on http://localhost:${info.port}`
      )
    })
  }
}
