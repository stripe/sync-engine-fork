import {
  condition,
  continueAsNew,
  startChild,
  getExternalWorkflowHandle,
  setHandler,
  ChildWorkflowFailure,
  ApplicationFailure,
} from '@temporalio/workflow'

import type { SourceInputMessage, SourceState } from '@stripe/sync-protocol'
import type { DesiredStatus, PipelineStatus } from '../../lib/createSchemas.js'
import { classifySyncErrors } from '../sync-errors.js'
import {
  desiredStatusSignal,
  credentialsUpdatedSignal,
  configUpdatedSignal,
  deploymentUpdatedSignal,
  pipelineSetup,
  sourceInputSignal,
  pipelineSync,
  pipelineTeardown,
  updatePipelineStatus,
} from './_shared.js'
import { pipelineBackfillWorkflow } from './pipeline-backfill-workflow.js'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000
const LIVE_EVENT_BATCH_SIZE = 10
const PIPELINE_CONTINUE_AS_NEW_THRESHOLD = 1000

export type ReconcileState = 'backfilling' | 'reconciling' | 'ready'
export type SetupState = 'started' | 'completed'
export type TeardownState = 'started' | 'completed'

export interface PipelineWorkflowState {
  phase?: ReconcileState
  paused?: boolean
  errored?: boolean
  setup?: SetupState
  teardown?: TeardownState
}

export interface PipelineWorkflowOpts {
  desiredStatus?: DesiredStatus
  sourceState?: SourceState
  inputQueue?: SourceInputMessage[]
  state?: PipelineWorkflowState
  errorRecoveryRequested?: boolean
}

/**
 * Extract the child's latest sourceState from a BackfillPermanentError.
 * The child encodes it as the first detail in ApplicationFailure.nonRetryable.
 */
function extractStateFromChildFailure(err: unknown): SourceState | undefined {
  if (err instanceof ChildWorkflowFailure && err.cause instanceof ApplicationFailure) {
    const detail = err.cause.details?.[0]
    if (detail && typeof detail === 'object' && 'streams' in detail) {
      return detail as SourceState
    }
  }
  return undefined
}

/**
 * Reset any streams with status 'errored' back to 'pending' so they are
 * retried on the next backfill run after recovery.
 */
function resetErroredStreams(state: SourceState): SourceState {
  const streams: Record<string, unknown> = {}
  for (const [name, data] of Object.entries(state.streams)) {
    const streamData = data as Record<string, unknown> | undefined
    if (streamData?.status === 'errored') {
      streams[name] = { ...streamData, status: 'pending' }
    } else {
      streams[name] = data
    }
  }
  return { ...state, streams }
}

export async function pipelineWorkflow(
  pipelineId: string,
  opts?: PipelineWorkflowOpts
): Promise<void> {
  const inputQueue: SourceInputMessage[] = opts?.inputQueue ? [...opts.inputQueue] : []
  let desiredStatus: DesiredStatus = opts?.desiredStatus ?? 'active'
  let sourceState: SourceState = opts?.sourceState ?? { streams: {}, global: {} }
  let state: PipelineWorkflowState = { ...opts?.state }
  let errorRecoveryRequested = opts?.errorRecoveryRequested ?? false

  let operationCount = 0

  setHandler(sourceInputSignal, (event: SourceInputMessage) => {
    inputQueue.push(event)
  })
  setHandler(desiredStatusSignal, (status: DesiredStatus) => {
    desiredStatus = status
    if (state.errored && status === 'active') {
      errorRecoveryRequested = true
    }
  })
  setHandler(credentialsUpdatedSignal, () => {
    if (state.errored) errorRecoveryRequested = true
  })
  setHandler(configUpdatedSignal, () => {
    if (state.errored) errorRecoveryRequested = true
  })
  setHandler(deploymentUpdatedSignal, () => {
    if (state.errored) errorRecoveryRequested = true
  })

  // MARK: - State

  function derivePipelineStatus(): PipelineStatus {
    if (state.teardown) return 'teardown'
    if (state.errored) return 'error'
    if (state.paused) return 'paused'
    if (state.setup !== 'completed') return 'setup'
    return state.phase === 'ready' ? 'ready' : 'backfill'
  }

  async function setState(next: Partial<PipelineWorkflowState>) {
    const previousStatus = derivePipelineStatus()
    state = { ...state, ...next }
    const nextStatus = derivePipelineStatus()

    if (previousStatus !== nextStatus) {
      await updatePipelineStatus(pipelineId, nextStatus)
    }
  }

  function runInterrupted() {
    return (
      desiredStatus !== 'active' ||
      operationCount >= PIPELINE_CONTINUE_AS_NEW_THRESHOLD ||
      !!state.errored
    )
  }

  async function markPermanentError(): Promise<void> {
    await setState({ errored: true })
  }

  async function waitForErrorRecovery(): Promise<void> {
    await condition(() => desiredStatus === 'deleted' || errorRecoveryRequested)
    errorRecoveryRequested = false
    if (desiredStatus === 'active') {
      sourceState = resetErroredStreams(sourceState)
      await setState({ errored: false })
    }
  }

  // MARK: - Live loop

  async function waitForLiveEvents(): Promise<SourceInputMessage[] | null> {
    await condition(() => inputQueue.length > 0 || runInterrupted())

    if (runInterrupted()) {
      return null
    }

    return inputQueue.splice(0, LIVE_EVENT_BATCH_SIZE)
  }

  async function liveLoop(): Promise<void> {
    while (true) {
      const events = await waitForLiveEvents()
      if (!events) return

      const result = await pipelineSync(pipelineId, { input: events })
      operationCount++
      const { permanent, transient } = classifySyncErrors(result.errors)
      if (permanent.length > 0) {
        await markPermanentError()
        return
      }
      if (transient.length > 0) {
        inputQueue.unshift(...events)
      }
    }
  }

  // MARK: - Backfill (child workflow)

  async function runBackfill(
    phase: 'backfilling' | 'reconciling',
    workflowId: string
  ): Promise<boolean> {
    await setState({ phase })
    const handle = await startChild(pipelineBackfillWorkflow, {
      workflowId,
      args: [pipelineId, { state: sourceState }],
    })

    type Outcome =
      | { kind: 'done'; state: SourceState }
      | { kind: 'interrupted' }
      | { kind: 'failed'; error: unknown }

    const outcome: Outcome = await Promise.race([
      handle
        .result()
        .then((s): Outcome => ({ kind: 'done', state: s }))
        .catch((err): Outcome => ({ kind: 'failed', error: err })),
      condition(() => runInterrupted()).then((): Outcome => ({ kind: 'interrupted' })),
    ])

    if (outcome.kind === 'done') {
      sourceState = outcome.state
      await setState({ phase: 'ready' })
      return true
    }
    if (outcome.kind === 'interrupted') {
      getExternalWorkflowHandle(workflowId).cancel().catch(() => {})
      return false
    }
    // kind === 'failed' — extract the child's latest state if available
    const childState = extractStateFromChildFailure(outcome.error)
    if (childState) sourceState = childState
    await markPermanentError()
    return false
  }

  // MARK: - Backfill loop (spawns child workflows)

  async function backfillLoop(): Promise<void> {
    // Resume whichever backfill phase was interrupted. `reconciling` should not
    // fall back to the initial backfill path after a pause/resume cycle.
    if (!state.phase || state.phase === 'backfilling') {
      const ok = await runBackfill('backfilling', `backfill-${pipelineId}`)
      if (!ok) return
    } else if (state.phase === 'reconciling') {
      const ok = await runBackfill('reconciling', `reconcile-${pipelineId}-${Date.now()}`)
      if (!ok) return
    }

    while (!runInterrupted()) {
      await condition(() => runInterrupted(), ONE_WEEK_MS)
      if (runInterrupted()) return

      await runBackfill('reconciling', `reconcile-${pipelineId}-${Date.now()}`)
    }
  }

  // MARK: - Main logic

  if (state.setup !== 'completed') {
    await setState({ setup: 'started' })
    await pipelineSetup(pipelineId)
    await setState({ setup: 'completed' })
  }

  while (desiredStatus !== 'deleted') {
    if (state.errored) {
      await waitForErrorRecovery()
      continue
    }

    if (desiredStatus === 'paused') {
      await setState({ paused: true })
      await condition(() => desiredStatus !== 'paused')
      await setState({ paused: false })
      continue
    }

    await Promise.all([liveLoop(), backfillLoop()])

    if (operationCount >= PIPELINE_CONTINUE_AS_NEW_THRESHOLD) {
      return await continueAsNew<typeof pipelineWorkflow>(pipelineId, {
        desiredStatus,
        sourceState,
        inputQueue,
        state,
        errorRecoveryRequested,
      })
    }
  }

  await setState({ teardown: 'started' })
  await pipelineTeardown(pipelineId)
  await setState({ teardown: 'completed' })
}
