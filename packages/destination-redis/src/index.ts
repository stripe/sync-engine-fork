import { Redis } from 'ioredis'
import type { Destination, DestinationInput, ConfiguredCatalog } from '@stripe/sync-protocol'
import defaultSpec from './spec.js'
import { log } from './logger.js'
import type { Config } from './spec.js'

export { configSchema, type Config } from './spec.js'

function createRedisClient(config: Config): Redis {
  if (config.url) {
    return new Redis(config.url, {
      tls: config.tls ? {} : undefined,
    })
  }
  return new Redis({
    host: config.host ?? 'localhost',
    port: config.port ?? 6379,
    password: config.password,
    db: config.db ?? 0,
    tls: config.tls ? {} : undefined,
  })
}

/** Build the Redis key from prefix, stream name, and primary key columns */
export function buildRecordKey(
  prefix: string,
  stream: string,
  primaryKeyColumns: string[],
  data: Record<string, unknown>
): string {
  const pk = primaryKeyColumns.map((col) => String(data[col] ?? '')).join(':')
  return `${prefix}${stream}:${pk}`
}

function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  return err.message || (err as NodeJS.ErrnoException).code || err.constructor.name
}

const destination = {
  async *spec() {
    yield { type: 'spec' as const, spec: defaultSpec }
  },

  async *check({ config }: { config: Config }) {
    let redis: Redis | undefined
    try {
      redis = createRedisClient(config)
      await redis.ping()
      yield {
        type: 'connection_status' as const,
        connection_status: { status: 'succeeded' as const },
      }
    } catch (err) {
      yield {
        type: 'connection_status' as const,
        connection_status: {
          status: 'failed' as const,
          message: err instanceof Error ? err.message : String(err),
        },
      }
    } finally {
      await redis?.quit()
    }
  },

  async *setup({ config, catalog }: { config: Config; catalog: ConfiguredCatalog }) {
    log.info(
      { streams: catalog.streams.map((s) => s.stream.name), key_prefix: config.key_prefix },
      'dest redis: setup (no-op for schemaless store)'
    )
  },

  async *teardown({ config }: { config: Config }) {
    const prefix = config.key_prefix ?? ''
    if (!prefix) {
      throw new Error(
        'Refusing to teardown Redis without a key_prefix — would delete all keys in the database'
      )
    }
    const redis = createRedisClient(config)
    try {
      let cursor = '0'
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100)
        cursor = next
        if (keys.length > 0) {
          await redis.del(...keys)
        }
      } while (cursor !== '0')
      log.info({ prefix }, 'dest redis: teardown complete')
    } finally {
      await redis.quit()
    }
  },

  async *write(
    { config, catalog }: { config: Config; catalog: ConfiguredCatalog },
    $stdin: AsyncIterable<DestinationInput>
  ) {
    const redis = createRedisClient(config)
    const batchSize = config.batch_size
    const keyPrefix = config.key_prefix ?? ''

    // Map stream name → primary key columns
    const streamKeyColumns = new Map(
      catalog.streams.map((cs) => [
        cs.stream.name,
        cs.stream.primary_key?.map((pk) => pk[0]) ?? ['id'],
      ])
    )

    const failedStreams = new Set<string>()

    // Per-stream buffers: array of { key, value }
    const streamBuffers = new Map<string, { key: string; value: string }[]>()

    /** Flush buffered records for a stream. Returns error message if failed. */
    const flushStream = async (streamName: string): Promise<string | undefined> => {
      if (failedStreams.has(streamName)) return undefined
      const buffer = streamBuffers.get(streamName)
      if (!buffer || buffer.length === 0) return undefined

      const startedAt = Date.now()
      log.debug({ stream: streamName, batch_size: buffer.length }, 'dest redis: flush start')

      try {
        const pipeline = redis.pipeline()
        for (const { key, value } of buffer) {
          pipeline.set(key, value)
        }
        await pipeline.exec()
        log.debug(
          {
            stream: streamName,
            batch_size: buffer.length,
            duration_ms: Date.now() - startedAt,
          },
          'dest redis: flush complete'
        )
      } catch (err) {
        const errMsg = errorMessage(err)
        log.error(
          { stream: streamName, batch_size: buffer.length, error: errMsg },
          'dest redis: flush failed'
        )
        failedStreams.add(streamName)
        streamBuffers.set(streamName, [])
        return `${errMsg} (stream=${streamName})`
      }
      streamBuffers.set(streamName, [])
      return undefined
    }

    function streamError(stream: string, error: string) {
      return {
        type: 'stream_status' as const,
        stream_status: { stream, status: 'error' as const, error },
      }
    }

    try {
      await redis.ping() // verify connection

      for await (const msg of $stdin) {
        if (msg.type === 'record') {
          const { stream, data } = msg.record

          if (failedStreams.has(stream)) {
            log.debug({ stream }, 'dest redis: skipping record for failed stream')
            continue
          }

          if (!streamBuffers.has(stream)) {
            streamBuffers.set(stream, [])
          }

          const pk = streamKeyColumns.get(stream) ?? ['id']
          const key = buildRecordKey(keyPrefix, stream, pk, data as Record<string, unknown>)
          const buffer = streamBuffers.get(stream)!
          buffer.push({ key, value: JSON.stringify(data) })

          if (buffer.length >= batchSize) {
            const err = await flushStream(stream)
            if (err) {
              log.error(
                { stream, error: err },
                'dest redis: yielding stream_status error (batch flush)'
              )
              yield streamError(stream, err)
              continue
            }
          }
          yield msg
        } else if (msg.type === 'source_state') {
          if (msg.source_state.state_type !== 'global') {
            const stream = msg.source_state.stream
            if (failedStreams.has(stream)) {
              log.debug({ stream }, 'dest redis: skipping source_state for failed stream')
              continue
            }
            const err = await flushStream(stream)
            if (err) {
              log.error(
                { stream, error: err },
                'dest redis: yielding stream_status error (state flush)'
              )
              yield streamError(stream, err)
              continue
            }
          }
          yield msg
        } else {
          yield msg
        }
      }

      // Final flush
      for (const streamName of streamBuffers.keys()) {
        const err = await flushStream(streamName)
        if (err) {
          log.error(
            { stream: streamName, error: err },
            'dest redis: yielding stream_status error (final flush)'
          )
          yield streamError(streamName, err)
        }
      }

      if (failedStreams.size > 0) {
        log.error(
          { failed_streams: [...failedStreams] },
          `Redis destination: completed with ${failedStreams.size} failed stream(s)`
        )
      } else {
        log.debug('Redis destination: write complete')
      }
    } finally {
      await redis.quit()
    }
  },
} satisfies Destination<Config>

export default destination
