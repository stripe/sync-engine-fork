import { createRemoteEngine } from '@stripe/sync-engine'
import type { PipelineConfig } from '@stripe/sync-engine'
import type { ActivitiesContext } from './_shared.js'
import { asIterable, drainMessages, type RunResult } from './_shared.js'

export function createSyncImmediateActivity(context: ActivitiesContext) {
  return async function syncImmediate(
    config: PipelineConfig,
    opts?: { input?: unknown[]; state?: Record<string, unknown>; stateLimit?: number }
  ): Promise<RunResult> {
    const engine = createRemoteEngine(context.engineUrl, config, {
      state: opts?.state,
      stateLimit: opts?.stateLimit,
    })
    const input = opts?.input?.length ? asIterable(opts.input) : undefined
    const { errors, state } = await drainMessages(
      engine.sync(input) as AsyncIterable<Record<string, unknown>>
    )
    return { errors, state }
  }
}
