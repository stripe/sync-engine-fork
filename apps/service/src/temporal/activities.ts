import { heartbeat } from '@temporalio/activity'
import { applySelection, buildCatalog, createRemoteEngine } from '@stripe/sync-engine'
import type {
  ConfiguredCatalog,
  Message,
  PipelineConfig,
  RecordMessage,
  SetupResult,
  Stream,
} from '@stripe/sync-engine'
import {
  parseGoogleSheetsMetaLog,
  ROW_KEY_FIELD,
  ROW_NUMBER_FIELD,
  serializeRowKey,
} from '@stripe/sync-destination-google-sheets'
import { Kafka } from 'kafkajs'

export interface RunResult {
  errors: Array<{ message: string; failure_type?: string; stream?: string }>
  state: Record<string, unknown>
}

/** Convert an array to an async iterable. */
async function* asIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

function pipelineHeader(config: PipelineConfig): string {
  return JSON.stringify(config)
}

function collectError(message: Record<string, unknown>): RunResult['errors'][number] | null {
  if (message.type !== 'error') return null
  return {
    message:
      (message.message as string) ||
      ((message.data as Record<string, unknown>)?.message as string) ||
      'Unknown error',
    failure_type: message.failure_type as string | undefined,
    stream: message.stream as string | undefined,
  }
}

function withRowKey(record: RecordMessage, catalog?: ConfiguredCatalog): RecordMessage {
  const primaryKey = catalog?.streams.find((stream) => stream.stream.name === record.stream)?.stream
    .primary_key
  if (!primaryKey) return record
  return {
    ...record,
    data: {
      ...record.data,
      [ROW_KEY_FIELD]: serializeRowKey(primaryKey, record.data),
    },
  }
}

function compactGoogleSheetsMessages(messages: Message[]): Message[] {
  const compacted: Message[] = []
  let pendingOrder: string[] = []
  let pending = new Map<string, RecordMessage>()

  const flushPending = () => {
    for (const key of pendingOrder) {
      const message = pending.get(key)
      if (message) compacted.push(message)
    }
    pendingOrder = []
    pending = new Map()
  }

  for (const message of messages) {
    if (message.type === 'record') {
      const rowKey =
        typeof message.data[ROW_KEY_FIELD] === 'string' ? message.data[ROW_KEY_FIELD] : undefined
      if (!rowKey) {
        compacted.push(message)
        continue
      }
      const dedupeKey = `${message.stream}:${rowKey}`
      if (!pending.has(dedupeKey)) pendingOrder.push(dedupeKey)
      pending.set(dedupeKey, message)
      continue
    }

    if (message.type === 'state') {
      flushPending()
      compacted.push(message)
    }
  }

  flushPending()
  return compacted
}

function addRowNumbers(
  messages: Message[],
  rowIndex: Record<string, Record<string, number>>
): Message[] {
  return messages.map((message) => {
    if (message.type !== 'record') return message
    const rowKey =
      typeof message.data[ROW_KEY_FIELD] === 'string' ? message.data[ROW_KEY_FIELD] : undefined
    const rowNumber = rowKey ? rowIndex[message.stream]?.[rowKey] : undefined
    if (rowNumber === undefined) return message
    return {
      ...message,
      data: {
        ...message.data,
        [ROW_NUMBER_FIELD]: rowNumber,
      },
    }
  })
}

/** Iterate a message stream, collecting errors/state/records and heartbeating. */
async function drainMessages(stream: AsyncIterable<Record<string, unknown>>): Promise<{
  errors: RunResult['errors']
  state: Record<string, unknown>
  records: unknown[]
}> {
  const errors: RunResult['errors'] = []
  const state: Record<string, unknown> = {}
  const records: unknown[] = []
  let count = 0

  for await (const message of stream) {
    count++
    const error = collectError(message)
    if (error) {
      errors.push(error)
    } else if (message.type === 'state' && typeof message.stream === 'string') {
      state[message.stream] = message.data
    } else if (message.type === 'record') {
      records.push(message)
    }
    if (count % 50 === 0) heartbeat({ messages: count })
  }
  if (count % 50 !== 0) heartbeat({ messages: count })

  return { errors, state, records }
}

export function createActivities(opts: { engineUrl: string; kafkaBroker?: string }) {
  const { engineUrl, kafkaBroker } = opts

  // Shared Kafka client + producer (created lazily, reused across activity calls)
  let kafka: Kafka | undefined
  let producerConnected: Promise<import('kafkajs').Producer> | undefined

  function getKafka(): Kafka {
    if (!kafka) {
      if (!kafkaBroker) throw new Error('kafkaBroker is required for read-write mode')
      kafka = new Kafka({ brokers: [kafkaBroker] })
    }
    return kafka
  }

  function getProducer(): Promise<import('kafkajs').Producer> {
    if (!producerConnected) {
      const producer = getKafka().producer()
      producerConnected = producer.connect().then(() => producer)
    }
    return producerConnected
  }

  function topicName(pipelineId: string): string {
    return `pipeline.${pipelineId}`
  }

  async function consumeQueueBatch(pipelineId: string, maxBatch: number): Promise<Message[]> {
    if (!kafkaBroker) throw new Error('kafkaBroker is required for read-write mode')

    const topic = topicName(pipelineId)
    const messages: Message[] = []
    const offsets = new Map<number, string>()
    const consumer = getKafka().consumer({ groupId: `pipeline.${pipelineId}` })
    await consumer.connect()
    await consumer.subscribe({ topic, fromBeginning: true })

    try {
      await new Promise<void>((resolve) => {
        let resolved = false
        const finish = () => {
          if (resolved) return
          resolved = true
          resolve()
        }

        consumer.run({
          eachMessage: async ({ partition, message }) => {
            if (message.value) {
              messages.push(JSON.parse(message.value.toString()) as Message)
              offsets.set(partition, (BigInt(message.offset) + 1n).toString())
            }
            if (messages.length >= maxBatch) finish()
          },
        })

        // If fewer than maxBatch messages are available, stop after a short wait.
        setTimeout(finish, 2000)
      })

      await consumer.stop()

      if (offsets.size > 0) {
        await consumer.commitOffsets(
          [...offsets.entries()].map(([partition, offset]) => ({
            topic,
            partition,
            offset,
          }))
        )
      }
    } finally {
      await consumer.disconnect()
    }

    return messages
  }

  return {
    async discoverCatalog(config: PipelineConfig): Promise<ConfiguredCatalog> {
      const response = await fetch(`${engineUrl}/discover`, {
        method: 'POST',
        headers: { 'x-pipeline': pipelineHeader(config) },
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`Engine /discover failed (${response.status}): ${text}`)
      }
      const payload = (await response.json()) as { streams: Stream[] }
      return applySelection(buildCatalog(payload.streams, config.streams))
    },

    async setup(config: PipelineConfig): Promise<SetupResult> {
      const engine = createRemoteEngine(engineUrl, config)
      return await engine.setup()
    },

    async syncImmediate(
      config: PipelineConfig,
      opts?: { input?: unknown[]; state?: Record<string, unknown>; stateLimit?: number }
    ): Promise<RunResult> {
      const engine = createRemoteEngine(engineUrl, config, {
        state: opts?.state,
        stateLimit: opts?.stateLimit,
      })
      const input = opts?.input?.length ? asIterable(opts.input) : undefined
      const { errors, state } = await drainMessages(
        engine.sync(input) as AsyncIterable<Record<string, unknown>>
      )
      return { errors, state }
    },

    async readIntoQueueWithState(
      config: PipelineConfig,
      pipelineId: string,
      opts?: {
        input?: unknown[]
        state?: Record<string, unknown>
        stateLimit?: number
        catalog?: ConfiguredCatalog
      }
    ): Promise<{ count: number; state: Record<string, unknown> }> {
      if (!kafkaBroker) throw new Error('kafkaBroker is required for Google Sheets workflow')

      const engine = createRemoteEngine(engineUrl, config, {
        state: opts?.state,
        stateLimit: opts?.stateLimit,
      })
      const input = opts?.input?.length ? asIterable(opts.input) : undefined

      const queued: Message[] = []
      const state: Record<string, unknown> = {}
      const errors: RunResult['errors'] = []
      let seen = 0

      for await (const raw of engine.read(input) as AsyncIterable<Record<string, unknown>>) {
        seen++
        const error = collectError(raw)
        if (error) {
          errors.push(error)
        } else if (raw.type === 'record') {
          queued.push(withRowKey(raw as RecordMessage, opts?.catalog))
        } else if (raw.type === 'state' && typeof raw.stream === 'string') {
          state[raw.stream] = raw.data
          queued.push(raw as Message)
        }
        if (seen % 50 === 0) heartbeat({ messages: seen })
      }
      if (seen % 50 !== 0) heartbeat({ messages: seen })

      if (errors.length > 0) {
        throw new Error(errors.map((error) => error.message).join('; '))
      }

      if (queued.length > 0) {
        const producer = await getProducer()
        await producer.send({
          topic: topicName(pipelineId),
          messages: queued.map((message) => ({ value: JSON.stringify(message) })),
        })
      }

      return { count: queued.length, state }
    },

    async readIntoQueue(
      config: PipelineConfig,
      pipelineId: string,
      opts?: { input?: unknown[]; state?: Record<string, unknown>; stateLimit?: number }
    ): Promise<{ count: number; state: Record<string, unknown> }> {
      const engine = createRemoteEngine(engineUrl, config, {
        state: opts?.state,
        stateLimit: opts?.stateLimit,
      })
      const input = opts?.input?.length ? asIterable(opts.input) : undefined
      const { records, state } = await drainMessages(
        engine.read(input) as AsyncIterable<Record<string, unknown>>
      )

      // If Kafka is configured, produce records to the pipeline topic
      if (kafkaBroker && records.length > 0) {
        const producer = await getProducer()
        await producer.send({
          topic: topicName(pipelineId),
          messages: records.map((record) => ({ value: JSON.stringify(record) })),
        })
      }

      return { count: records.length, state }
    },

    async writeGoogleSheetsFromQueue(
      config: PipelineConfig,
      pipelineId: string,
      opts?: {
        maxBatch?: number
        rowIndex?: Record<string, Record<string, number>>
      }
    ): Promise<
      RunResult & {
        written: number
        rowAssignments: Record<string, Record<string, number>>
      }
    > {
      if (!kafkaBroker) throw new Error('kafkaBroker is required for Google Sheets workflow')

      const maxBatch = opts?.maxBatch ?? 50
      const queued = await consumeQueueBatch(pipelineId, maxBatch)

      if (queued.length === 0) {
        return { errors: [], state: {}, written: 0, rowAssignments: {} }
      }

      const writeBatch = addRowNumbers(compactGoogleSheetsMessages(queued), opts?.rowIndex ?? {})

      const engine = createRemoteEngine(engineUrl, config)
      const errors: RunResult['errors'] = []
      const state: Record<string, unknown> = {}
      const rowAssignments: Record<string, Record<string, number>> = {}

      for await (const raw of engine.write(asIterable(writeBatch)) as AsyncIterable<
        Record<string, unknown>
      >) {
        const error = collectError(raw)
        if (error) {
          errors.push(error)
        } else if (raw.type === 'state' && typeof raw.stream === 'string') {
          state[raw.stream] = raw.data
        } else if (raw.type === 'log' && typeof raw.message === 'string') {
          const meta = parseGoogleSheetsMetaLog(raw.message)
          if (meta?.type === 'row_assignments') {
            for (const [stream, assignments] of Object.entries(meta.assignments)) {
              rowAssignments[stream] ??= {}
              Object.assign(rowAssignments[stream], assignments)
            }
          }
        }
      }

      return { errors, state, written: queued.length, rowAssignments }
    },

    async writeFromQueue(
      config: PipelineConfig,
      pipelineId: string,
      opts?: { records?: unknown[]; maxBatch?: number }
    ): Promise<RunResult & { written: number }> {
      let records: unknown[]

      if (kafkaBroker) {
        const maxBatch = opts?.maxBatch ?? 50
        records = await consumeQueueBatch(pipelineId, maxBatch)
      } else {
        // In-memory mode: records passed directly
        records = opts?.records ?? []
      }

      if (records.length === 0) {
        return { errors: [], state: {}, written: 0 }
      }

      const engine = createRemoteEngine(engineUrl, config)
      const { errors, state } = await drainMessages(
        engine.write(asIterable(records) as AsyncIterable<Message>) as AsyncIterable<
          Record<string, unknown>
        >
      )

      return { errors, state, written: records.length }
    },

    async teardown(config: PipelineConfig): Promise<void> {
      const engine = createRemoteEngine(engineUrl, config)
      await engine.teardown()
    },
  }
}

export type SyncActivities = ReturnType<typeof createActivities>
