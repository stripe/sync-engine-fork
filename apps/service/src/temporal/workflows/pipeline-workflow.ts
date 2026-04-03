import { condition, continueAsNew, setHandler } from '@temporalio/workflow'

import {
  configQuery,
  deleteSignal,
  Pipeline,
  setup,
  stateQuery,
  statusQuery,
  stripeEventSignal,
  syncImmediate,
  teardown,
  toConfig,
  updateSignal,
  WorkflowStatus,
} from './_shared.js'
import { CONTINUE_AS_NEW_THRESHOLD, EVENT_BATCH_SIZE } from '../../lib/utils.js'

export interface PipelineWorkflowOpts {
  phase?: string
  state?: Record<string, unknown>
  timeLimit?: number
  inputQueue?: unknown[]
}

export async function pipelineWorkflow(
  pipeline: Pipeline,
  opts?: PipelineWorkflowOpts
): Promise<void> {
  let paused = false
  let deleted = false
  const inputQueue: unknown[] = [...(opts?.inputQueue ?? [])]
  let iteration = 0
  let syncState: Record<string, unknown> = opts?.state ?? {}
  let readComplete = false

  setHandler(stripeEventSignal, (event: unknown) => {
    inputQueue.push(event)
  })
  setHandler(updateSignal, (patch: Partial<Pipeline>) => {
    if (patch.source) pipeline = { ...pipeline, source: patch.source }
    if (patch.destination) pipeline = { ...pipeline, destination: patch.destination }
    if (patch.streams !== undefined) pipeline = { ...pipeline, streams: patch.streams }
    if ('paused' in (patch as Record<string, unknown>)) {
      paused = !!(patch as Record<string, unknown>).paused
    }
  })
  setHandler(deleteSignal, () => {
    deleted = true
  })

  const phase = opts?.phase ?? 'setup'
  setHandler(
    statusQuery,
    (): WorkflowStatus => ({
      phase: phase === 'setup' && iteration > 0 ? 'running' : phase,
      paused,
      iteration,
    })
  )
  setHandler(configQuery, (): Pipeline => pipeline)
  setHandler(stateQuery, (): Record<string, unknown> => syncState)

  async function waitWhilePaused() {
    await condition(() => !paused || deleted)
  }

  async function tickIteration() {
    iteration++
    if (iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof pipelineWorkflow>(pipeline, {
        phase: 'running',
        state: syncState,
        timeLimit: opts?.timeLimit,
        inputQueue: inputQueue.length > 0 ? [...inputQueue] : undefined,
      })
    }
  }

  if (phase !== 'running') {
    const setupResult = await setup(toConfig(pipeline))
    if (setupResult.source) {
      pipeline = { ...pipeline, source: { ...pipeline.source, ...setupResult.source } }
    }
    if (setupResult.destination) {
      pipeline = {
        ...pipeline,
        destination: { ...pipeline.destination, ...setupResult.destination },
      }
    }
    if (deleted) {
      await teardown(toConfig(pipeline))
      return
    }
  }

  while (true) {
    await waitWhilePaused()
    if (deleted) break

    const config = toConfig(pipeline)

    if (inputQueue.length > 0) {
      const batch = inputQueue.splice(0, EVENT_BATCH_SIZE)
      await syncImmediate(config, { input: batch })
      await tickIteration()
      continue
    }

    if (!readComplete) {
      const result = await syncImmediate(config, {
        state: syncState,
        stateLimit: 1,
        timeLimit: opts?.timeLimit,
      })
      syncState = { ...syncState, ...result.state }
      readComplete = result.eof?.reason === 'complete'
      await tickIteration()
      continue
    }

    await condition(() => inputQueue.length > 0 || deleted)
  }

  await teardown(toConfig(pipeline))
}
