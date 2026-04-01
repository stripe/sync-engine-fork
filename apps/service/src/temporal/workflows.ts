import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  continueAsNew,
} from '@temporalio/workflow'

import type { SyncActivities } from './activities.js'
import type { WorkflowStatus } from './types.js'

const CONTINUE_AS_NEW_THRESHOLD = 500

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bArr = b as unknown[]
    return a.length === bArr.length && a.every((v, i) => deepEqual(v, bArr[i]))
  }
  const aKeys = Object.keys(a as object)
  const bKeys = Object.keys(b as object)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}
const EVENT_BATCH_SIZE = 50

const retryPolicy = {
  initialInterval: '1s',
  backoffCoefficient: 2.0,
  maximumInterval: '5m',
  maximumAttempts: 10,
} as const

// Setup/teardown: 2m with retry
const { setup, teardown } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '2m',
  retry: retryPolicy,
})

// Run: 10m with retry and heartbeat
const { sync } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '10m',
  heartbeatTimeout: '2m',
  retry: retryPolicy,
})

// Signals
export const stripeEventSignal = defineSignal<[unknown]>('stripe_event')
export const pauseSignal = defineSignal('pause')
export const resumeSignal = defineSignal('resume')
export const deleteSignal = defineSignal('delete')

// Query
export const statusQuery = defineQuery<WorkflowStatus>('status')

export async function realtimePipelineWorkflow(
  pipelineId: string,
  opts?: { phase?: string; state?: Record<string, unknown> }
): Promise<void> {
  let paused = false
  let deleted = false
  const eventBuffer: unknown[] = []
  let iteration = 0
  let syncState: Record<string, unknown> = opts?.state ?? {}
  let reconciled = false

  // Register signal handlers (must be before any await)
  setHandler(stripeEventSignal, (event: unknown) => {
    eventBuffer.push(event)
  })
  setHandler(pauseSignal, () => {
    paused = true
  })
  setHandler(resumeSignal, () => {
    paused = false
  })
  setHandler(deleteSignal, () => {
    deleted = true
  })

  // Register query handler
  const phase = opts?.phase ?? 'setup'
  setHandler(
    statusQuery,
    (): WorkflowStatus => ({
      phase: phase === 'setup' && iteration > 0 ? 'running' : phase,
      paused,
      iteration,
    })
  )

  // --- Helpers ---

  async function waitWhilePaused() {
    await condition(() => !paused || deleted)
  }

  async function tickIteration() {
    iteration++
    if (iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof realtimePipelineWorkflow>(pipelineId, {
        phase: 'running',
        state: syncState,
      })
    }
  }

  // --- Setup (first sync only) ---

  if (phase !== 'running') {
    await setup(pipelineId)
    if (deleted) {
      await teardown(pipelineId)
      return
    }
  }

  // --- Main loop: continuous reconciliation + optimistic updates ---

  while (true) {
    await waitWhilePaused()
    if (deleted) break

    // 1. Drain buffered events
    if (eventBuffer.length > 0) {
      const batch = eventBuffer.splice(0, EVENT_BATCH_SIZE)
      await sync(pipelineId, { input: batch })
      await tickIteration()
      continue // Re-check for more events before reconciliation
    }

    // 2. Reconciliation: one page at a time; done when state stops changing
    if (!reconciled) {
      const before = syncState
      const result = await sync(pipelineId, { state: syncState, stateLimit: 1 })
      syncState = { ...syncState, ...result.state }
      reconciled = deepEqual(syncState, before)
      await tickIteration()
      continue
    }

    // 3. All streams caught up — wait for a new event or delete signal
    await condition(() => eventBuffer.length > 0 || deleted)
  }

  // Teardown on delete
  await teardown(pipelineId)
}
