giimport { condition, continueAsNew, setHandler } from '@temporalio/workflow'

import { desiredStatusSignal, pipelineSync, updatePipelineStatus } from './_shared.js'
import type { DesiredStatus } from '../../lib/createSchemas.js'
import type { SourceState as SyncState } from '@stripe/sync-protocol'
import { CONTINUE_AS_NEW_THRESHOLD } from '../../lib/utils.js'
import { classifySyncErrors } from '../sync-errors.js'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface BackfillPipelineWorkflowOpts {
  desiredStatus?: DesiredStatus
  state?: SyncState
}

export async function backfillPipelineWorkflow(
  pipelineId: string,
  opts?: BackfillPipelineWorkflowOpts
): Promise<void> {
  let desiredStatus: DesiredStatus = opts?.desiredStatus ?? 'active'
  let iteration = 0
  let syncState: SyncState = opts?.state ?? { streams: {}, global: {} }
  let backfillComplete = false
  let errored = false
  let desiredStatusSignalCount = 0

  setHandler(desiredStatusSignal, (status: string) => {
    desiredStatus = status as DesiredStatus
    desiredStatusSignalCount++
  })

  async function maybeContinueAsNew() {
    if (++iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof backfillPipelineWorkflow>(pipelineId, {
        desiredStatus,
        state: syncState,
      })
    }
  }

  await updatePipelineStatus(pipelineId, 'backfill')

  while (desiredStatus !== 'deleted') {
    if (errored) {
      await updatePipelineStatus(pipelineId, 'error')
      const signalCount = desiredStatusSignalCount
      await condition(() => desiredStatus === 'deleted' || desiredStatusSignalCount > signalCount)
      if (desiredStatus === 'active') {
        errored = false
      }
      continue
    }

    if (desiredStatus === 'paused') {
      await updatePipelineStatus(pipelineId, 'paused')
      await condition(() => desiredStatus !== 'paused')
      continue
    }

    if (backfillComplete) {
      await updatePipelineStatus(pipelineId, 'ready')
      const timedOut = !(await condition(() => desiredStatus !== 'active', ONE_WEEK_MS))
      if (timedOut) backfillComplete = false
      continue
    }

    const result = await pipelineSync(pipelineId, {
      state: syncState,
      state_limit: 100,
      time_limit: 10,
    })
    syncState = {
      streams: { ...syncState.streams, ...result.state.streams },
      global: { ...syncState.global, ...result.state.global },
    }
    if (classifySyncErrors(result.errors).permanent.length > 0) {
      errored = true
      backfillComplete = false
      continue
    }
    backfillComplete = result.eof?.reason === 'complete'
    await maybeContinueAsNew()
  }

  await updatePipelineStatus(pipelineId, 'teardown')
}
