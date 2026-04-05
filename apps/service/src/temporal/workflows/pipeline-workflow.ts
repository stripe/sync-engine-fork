import { condition, continueAsNew, setHandler } from '@temporalio/workflow'

import type { SourceInputMessage, SourceState } from '@stripe/sync-protocol'
import type { DesiredStatus } from '../../lib/createSchemas.js'
import { CONTINUE_AS_NEW_THRESHOLD, EVENT_BATCH_SIZE } from '../../lib/utils.js'
import {
  desiredStatusSignal,
  setup,
  stripeEventSignal,
  syncImmediate,
  teardown,
  updatePipelineStatus,
} from './_shared.js'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface PipelineWorkflowOpts {
  desiredStatus?: DesiredStatus
  sourceState?: SourceState
  inputQueue?: SourceInputMessage[]
}

export async function pipelineWorkflow(
  pipelineId: string,
  opts?: PipelineWorkflowOpts
): Promise<void> {
  let desiredStatus = opts?.desiredStatus ?? 'active'
  const inputQueue: SourceInputMessage[] = [...(opts?.inputQueue ?? [])]
  let iteration = 0
  let syncState: SourceState = opts?.sourceState ?? { streams: {}, global: {} }
  let readComplete = false

  setHandler(stripeEventSignal, (event: SourceInputMessage) => {
    inputQueue.push(event)
  })
  setHandler(desiredStatusSignal, (status: DesiredStatus) => {
    desiredStatus = status
  })

  async function maybeContinueAsNew() {
    if (++iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof pipelineWorkflow>(pipelineId, {
        desiredStatus,
        sourceState: syncState,
        inputQueue: inputQueue.length > 0 ? [...inputQueue] : undefined,
      })
    }
  }

  // Setup
  await setup(pipelineId)
  await updatePipelineStatus(pipelineId, 'backfill')

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (desiredStatus === 'deleted') {
      break
    }

    if (desiredStatus === 'paused') {
      await updatePipelineStatus(pipelineId, 'paused')
      await condition(() => desiredStatus !== 'paused')
      continue
    }

    // Resuming from paused — update status
    if (readComplete) {
      await updatePipelineStatus(pipelineId, 'ready')
    } else {
      await updatePipelineStatus(pipelineId, 'backfill')
    }

    if (readComplete && inputQueue.length === 0) {
      // Idle — wait up to one week; timeout means recon is due.
      const timedOut = !(await condition(() => desiredStatus !== 'active' || inputQueue.length > 0, ONE_WEEK_MS))
      if (timedOut) readComplete = false
      continue
    }

    if (inputQueue.length > 0) {
      const batch = inputQueue.splice(0, EVENT_BATCH_SIZE)
      await syncImmediate(pipelineId, { input: batch })
    } else {
      const result = await syncImmediate(pipelineId, {
        state: syncState,
        state_limit: 100,
        time_limit: 10,
      })
      syncState = {
        streams: { ...syncState.streams, ...result.state.streams },
        global: { ...syncState.global, ...result.state.global },
      }
      if (result.eof?.reason === 'complete') {
        readComplete = true
        await updatePipelineStatus(pipelineId, 'ready')
      }
    }

    await maybeContinueAsNew()
  }

  await updatePipelineStatus(pipelineId, 'teardown')
  await teardown(pipelineId)
}
