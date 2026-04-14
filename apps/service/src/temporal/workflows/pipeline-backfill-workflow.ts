import { ApplicationFailure, continueAsNew } from '@temporalio/workflow'

import type { SourceState } from '@stripe/sync-protocol'
import { classifySyncErrors, summarizeSyncErrors, type SyncRunError } from '../sync-errors.js'
import { pipelineSync } from './_shared.js'

const BACKFILL_CONTINUE_AS_NEW_THRESHOLD = 500

export async function pipelineBackfillWorkflow(
  pipelineId: string,
  opts: { state: SourceState; accumulatedErrors?: SyncRunError[] }
): Promise<SourceState> {
  let sourceState = opts.state
  let operationCount = 0
  const accumulatedErrors: SyncRunError[] = opts.accumulatedErrors
    ? [...opts.accumulatedErrors]
    : []

  while (true) {
    const result = await pipelineSync(pipelineId, {
      state: sourceState,
      state_limit: 100,
      time_limit: 10,
    })
    operationCount++
    sourceState = result.state

    for (const err of result.errors) {
      accumulatedErrors.push(err)
    }

    if (result.eof?.reason === 'complete') {
      const { permanent } = classifySyncErrors(accumulatedErrors)
      if (permanent.length > 0) {
        throw ApplicationFailure.nonRetryable(
          summarizeSyncErrors(permanent),
          'BackfillPermanentError',
          sourceState
        )
      }
      return sourceState
    }

    if (operationCount >= BACKFILL_CONTINUE_AS_NEW_THRESHOLD) {
      const { permanent } = classifySyncErrors(accumulatedErrors)
      await continueAsNew<typeof pipelineBackfillWorkflow>(pipelineId, {
        state: sourceState,
        accumulatedErrors: permanent,
      })
    }
  }
}
