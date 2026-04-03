import { createRemoteEngine } from '@stripe/sync-engine'
import type { PipelineConfig } from '@stripe/sync-engine'
import type { ActivitiesContext } from './_shared.js'
import { asIterable, drainMessages } from './_shared.js'

export function createReadIntoQueueActivity(context: ActivitiesContext) {
  return async function readIntoQueue(
    config: PipelineConfig,
    pipelineId: string,
    opts?: { input?: unknown[]; state?: Record<string, unknown>; stateLimit?: number }
  ): Promise<{ count: number; state: Record<string, unknown> }> {
    const engine = createRemoteEngine(context.engineUrl, config, {
      state: opts?.state,
      stateLimit: opts?.stateLimit,
    })
    const input = opts?.input?.length ? asIterable(opts.input) : undefined
    const { records, state } = await drainMessages(
      engine.read(input) as AsyncIterable<Record<string, unknown>>
    )

    if (context.kafkaBroker && records.length > 0) {
      const producer = await context.getProducer()
      await producer.send({
        topic: `pipeline.${pipelineId}`,
        messages: records.map((record) => ({ value: JSON.stringify(record) })),
      })
    }

    return { count: records.length, state }
  }
}
