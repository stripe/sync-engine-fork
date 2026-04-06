import { condition, continueAsNew, setHandler } from '@temporalio/workflow'

import type { SourceInputMessage, SourceState } from '@stripe/sync-protocol'
import type { DesiredStatus, PipelineStatus } from '../../lib/createSchemas.js'
import { CONTINUE_AS_NEW_THRESHOLD } from '../../lib/utils.js'
import {
  desiredStatusSignal,
  setup,
  sourceInputSignal,
  pipelineSync,
  teardown,
  updatePipelineStatus,
} from './_shared.js'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000
const LIVE_EVENT_BATCH_SIZE = 10

export interface PipelineWorkflowOpts {
  desiredStatus?: DesiredStatus
  sourceState?: SourceState
  inputQueue?: SourceInputMessage[]
  eofCompleted?: boolean
  setupDone?: boolean
}

export async function pipelineWorkflow(
  pipelineId: string,
  opts?: PipelineWorkflowOpts
): Promise<void> {
  let desiredStatus: DesiredStatus = opts?.desiredStatus ?? 'active'
  const inputQueue: SourceInputMessage[] = [...(opts?.inputQueue ?? [])]
  let operationCount = 0
  let sourceState: SourceState = opts?.sourceState ?? { streams: {}, global: {} }
  let eofCompleted = opts?.eofCompleted ?? false
  let setupDone = opts?.setupDone ?? false
  let workflowStatus: PipelineStatus = setupDone ? (eofCompleted ? 'ready' : 'backfill') : 'setup'

  setHandler(sourceInputSignal, (event: SourceInputMessage) => {
    inputQueue.push(event)
  })
  setHandler(desiredStatusSignal, (status: DesiredStatus) => {
    desiredStatus = status
  })

  async function setStatus(status: PipelineStatus) {
    if (workflowStatus === status) return
    workflowStatus = status
    await updatePipelineStatus(pipelineId, status)
  }
  function running() {
    return desiredStatus !== 'deleted' && operationCount < CONTINUE_AS_NEW_THRESHOLD
  }

  // MARK: - Main logic

  if (!setupDone) {
    await setup(pipelineId)
    setupDone = true
  }
  await setStatus(eofCompleted ? 'ready' : 'backfill')


  async function liveLoop(): Promise<void> {
    while (running()) {
      if (desiredStatus !== 'active') {
        await setStatus('paused')
        await condition(() => desiredStatus !== 'paused')
        if (desiredStatus !== 'deleted') await setStatus(eofCompleted ? 'ready' : 'backfill')
        continue
      }
      if (inputQueue.length === 0) {
        await condition(() => inputQueue.length > 0 || desiredStatus !== 'active')
        continue
      }
      const batch = inputQueue.splice(0, LIVE_EVENT_BATCH_SIZE)
      await pipelineSync(pipelineId, { input: batch })
      operationCount++
    }
  }

  async function backfillLoop(): Promise<void> {
    while (running()) {
      if (desiredStatus !== 'active') {
        await condition(() => desiredStatus !== 'paused')
        continue
      }
      if (eofCompleted) {
        const timedOut = !(await condition(() => desiredStatus !== 'active' || !eofCompleted, ONE_WEEK_MS))
        if (timedOut) {
          eofCompleted = false
          await setStatus('backfill')
        }
        continue
      }
      const result = await pipelineSync(pipelineId, {
        state: sourceState,
        state_limit: 100,
        time_limit: 10,
      })
      sourceState = result.state
      if (result.eof?.reason === 'complete') {
        eofCompleted = true
        await setStatus('ready')
      }
      operationCount++
    }
  }

  await Promise.all([liveLoop(), backfillLoop()])

  // === Teardown ===
  if (desiredStatus === 'deleted') {
    await setStatus('teardown')
    await teardown(pipelineId)
    return
  }

  // === Rollover ===
  await continueAsNew<typeof pipelineWorkflow>(pipelineId, {
    desiredStatus,
    sourceState,
    inputQueue: inputQueue.length > 0 ? [...inputQueue] : undefined,
    eofCompleted,
    setupDone,
  })
}
