import { heartbeat } from '@temporalio/activity'
import { createRemoteEngine } from '@stripe/sync-engine'
import type { ConfiguredCatalog, Message, PipelineConfig, RecordMessage } from '@stripe/sync-engine'
import type { ActivitiesContext } from './_shared.js'
import { asIterable, collectError, type RunResult, withRowKey } from './_shared.js'

export function createReadIntoQueueWithStateActivity(context: ActivitiesContext) {
  return async function readIntoQueueWithState(
    config: PipelineConfig,
    pipelineId: string,
    opts?: {
      input?: unknown[]
      state?: Record<string, unknown>
      stateLimit?: number
      catalog?: ConfiguredCatalog
    }
  ): Promise<{ count: number; state: Record<string, unknown> }> {
    if (!context.kafkaBroker) throw new Error('kafkaBroker is required for Google Sheets workflow')

    const engine = createRemoteEngine(context.engineUrl, config, {
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
      const producer = await context.getProducer()
      await producer.send({
        topic: `pipeline.${pipelineId}`,
        messages: queued.map((message) => ({ value: JSON.stringify(message) })),
      })
    }

    return { count: queued.length, state }
  }
}
