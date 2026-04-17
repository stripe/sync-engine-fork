// Pipeline config and connector state are passed via HTTP headers.
// Node.js defaults to 16 KB which is too small for resumed syncs that carry
// both X-Pipeline and X-State. Keep the CLI serve path and API entrypoint on
// the same ceiling so the deployed container and local API behave the same way.
export const ENGINE_SERVER_OPTIONS = {
  maxHeaderSize: 50 * 1024 * 1024,
} as const
