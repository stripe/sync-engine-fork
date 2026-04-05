import { condition, continueAsNew, setHandler } from '@temporalio/workflow'

import type { SourceInputMessage, SourceState } from '@stripe/sync-protocol'
import type { DesiredStatus, WorkflowStatus } from '../../lib/createSchemas.js'
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
  let sourceState: SourceState = opts?.sourceState ?? { streams: {}, global: {} }
  let eofCompleted = false
  let workflowStatus: WorkflowStatus = 'setup'

  async function setStatus(status: WorkflowStatus) {
    if (workflowStatus === status) return
    workflowStatus = status
    await updatePipelineStatus(pipelineId, status)
  }

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
        sourceState: sourceState,
        inputQueue: inputQueue.length > 0 ? [...inputQueue] : undefined,
      })
    }
  }

  // Setup
  await setup(pipelineId)
  await setStatus('backfill')

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (desiredStatus === 'deleted') {
      break
    }

    if (desiredStatus === 'paused') {
      await setStatus('paused')
      await condition(() => desiredStatus !== 'paused')
      continue
    }

    await setStatus(eofCompleted ? 'ready' : 'backfill')

    if (eofCompleted && inputQueue.length === 0) {
      // Idle — wait up to one week; timeout means recon is due.
      const timedOut = !(await condition(
        () => desiredStatus !== 'active' || inputQueue.length > 0,
        ONE_WEEK_MS
      ))
      if (timedOut) eofCompleted = false
      continue
    }

    if (inputQueue.length > 0) {
      const batch = inputQueue.splice(0, EVENT_BATCH_SIZE)
      await syncImmediate(pipelineId, { input: batch })
    } else {
      const result = await syncImmediate(pipelineId, {
        state: sourceState,
        state_limit: 100,
        time_limit: 10,
      })
      sourceState = result.state
      if (result.eof?.reason === 'complete') {
        eofCompleted = true
        await setStatus('ready')
      }
    }

    await maybeContinueAsNew()
  }

  await setStatus('teardown')
  await teardown(pipelineId)
}
