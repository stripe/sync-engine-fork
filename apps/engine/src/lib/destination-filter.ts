import type { ConfiguredCatalog, ProgressPayload } from '@stripe/sync-protocol'

export type CatalogMiddleware = (catalog: ConfiguredCatalog) => ConfiguredCatalog

/**
 * Prune each stream's json_schema.properties down to the fields selected in
 * ConfiguredStream.fields (plus all primary-key fields).
 * Streams without fields or without json_schema pass through unchanged.
 */
export function applySelection(catalog: ConfiguredCatalog): ConfiguredCatalog {
  return {
    streams: catalog.streams.map((cs) => {
      if (!cs.fields?.length) return cs
      const props = cs.stream.json_schema?.properties as Record<string, unknown> | undefined
      if (!props) return cs
      const allowed = new Set(cs.fields)
      for (const path of cs.stream.primary_key) {
        if (path[0]) allowed.add(path[0])
      }
      return {
        ...cs,
        stream: {
          ...cs.stream,
          json_schema: {
            ...cs.stream.json_schema,
            properties: Object.fromEntries(Object.entries(props).filter(([k]) => allowed.has(k))),
          },
        },
      }
    }),
  }
}

/**
 * Exclude streams that already reached a terminal state in prior run progress.
 *
 * When `keepCompleted` is true, only errored/skipped streams are excluded —
 * completed streams stay in the catalog. This is load-bearing for live-event
 * sources (webhooks, websocket): completed means "backfill done", not "stop
 * routing events", so live events must continue to reach the stream. Source
 * backfill implementations short-circuit completed streams via state
 * (e.g. `remaining: []`), so there's no cost to keeping them in the catalog.
 */
export function excludeTerminalStreams(
  catalog: ConfiguredCatalog,
  progress?: Pick<ProgressPayload, 'streams'>,
  opts?: { keepCompleted?: boolean }
): ConfiguredCatalog {
  const keepCompleted = opts?.keepCompleted ?? false
  const terminalStreams = new Set(
    Object.entries(progress?.streams ?? {})
      .filter(([, stream]) => {
        if (stream.status === 'skipped' || stream.status === 'errored') return true
        if (stream.status === 'completed') return !keepCompleted
        return false
      })
      .map(([name]) => name)
  )

  if (terminalStreams.size === 0) return catalog

  return {
    ...catalog,
    streams: catalog.streams.filter((stream) => !terminalStreams.has(stream.stream.name)),
  }
}
