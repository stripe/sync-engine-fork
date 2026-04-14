# Backfill Child Workflow + Never-Fail Pipeline

**Status**: Plan (not yet implemented)
**Context**: [PR #284](https://github.com/stripe/sync-engine-fork/pull/284) cleaned up `SKIPPABLE_ERROR_PATTERNS`; discussion about workflow failure vs. pause, child workflows vs. activities

## Problem

The pipeline workflow has two structural problems:

**1. Monolithic workflow does too much.** `pipelineWorkflow` handles setup, backfill, live events, reconciliation, error recovery, pause/resume, teardown, and `continueAsNew` in one event history. Backfill has no completion semantics, dominates the event history, and a poison stream during backfill kills live event processing.

**2. Workflows can die from transient errors.** When `pipelineSync` encounters only transient/system errors, it throws `ApplicationFailure.retryable`. Temporal retries up to 10 times. If the error persists, the workflow execution dies — losing state and requiring a new execution. Most `system_error` cases (connector bugs, schema mismatches) are deterministic and won't self-heal; retrying them wastes 30 minutes before the workflow dies anyway.

## Design principles

1. **The pipeline workflow never fails.** It's an entity that lives until deleted. Errors are states, not exits.
2. **The backfill child workflow can fail.** It's a task with a goal. If it can't succeed, it should fail — but only after giving every stream a chance to complete.
3. **One stream's failure shouldn't block others.** The child runs all streams to completion (or individual failure), accumulates errors, then decides: all succeeded → return, some had non-retryable errors → fail with the full error picture.
4. **Backfill and reconcile are the same operation.** Both run `listApiBackfill` which skips complete streams and paginates incomplete ones. The only difference is starting state.

## Architecture

The parent has a **backfill loop** — logic that spawns child workflows for initial backfill and periodic reconciliation. Each child workflow is a single **backfill run** (`pipelineBackfillWorkflow`) that processes all streams and either succeeds or fails.

```
pipelineWorkflow (entity — never fails)
│
├── setup (activity)
│
├── backfill loop:
│   ├── executeChild(pipelineBackfillWorkflow)                  ← initial backfill
│   │   ├── runs all streams, accumulates errors
│   │   ├── success: returns final sourceState
│   │   └── failure: ChildWorkflowFailure → parent parks, waits for signal
│   │
│   └── on schedule or signal:
│       └── executeChild(pipelineBackfillWorkflow)              ← reconcile (same workflow, later state)
│
├── live loop:
│   └── receive events via signal → pipelineSync (activity)
│
├── on child failure or live error:
│   └── park in errored state, wait for recovery signal
└── on delete: teardown (activity)
```

## `pipelineBackfillWorkflow` child workflow

### Behavior

A single backfill run. Calls `pipelineSync` in a loop, processing chunks of work. Errors from individual streams are accumulated but don't stop the run — other streams continue. Only after all streams have had their chance (eof) does the child evaluate the result.

```ts
export async function pipelineBackfillWorkflow(
  pipelineId: string,
  opts: { state: SourceState }
): Promise<SourceState> {
  let sourceState = opts.state
  let operationCount = 0
  const accumulatedErrors: SyncRunError[] = []

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
          { state: sourceState, errors: permanent }
        )
      }
      return sourceState
    }

    if (operationCount >= BACKFILL_CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof pipelineBackfillWorkflow>(pipelineId, { state: sourceState })
    }
  }
}
```

### What this means for `pipelineSync` activity

Today the activity has two paths:

- Permanent errors → return `{ errors, state }`
- Transient errors → throw `ApplicationFailure.retryable`

For the child workflow model, the activity should **always return** — both permanent and transient errors come back as `{ errors, state }`. The child workflow decides what to do. Transient errors from one chunk don't stop the next chunk from running (different streams may be affected). The activity's Temporal retry policy still handles transport-level failures (activity crash, network error to the engine), but classified sync errors are always returned.

```ts
// pipeline-sync.ts — proposed
export function createPipelineSyncActivity(context: ActivitiesContext) {
  return async function pipelineSync(
    pipelineId: string,
    opts?: SourceReadOptions & { input?: SourceInputMessage[] }
  ): Promise<RunResult & { eof?: EofPayload }> {
    // ... same as today up to drainMessages ...
    // Always return — let the workflow decide
    return { errors, state, eof }
  }
}
```

### What this means for the source connector

The source needs to **continue past stream errors** and mark errored streams so they don't block eof. Today `listApiBackfill` already does this partially — the `catch` block emits an error trace and `continue`s to the next stream. But the errored stream's state isn't advanced, so the next `pipelineSync` call would retry it.

Two options:

- **Mark errored streams as complete** (with an error flag in state) so they're skipped on the next chunk. The child accumulates the error and reports it at the end.
- **Mark errored streams as `errored`** (new status alongside `complete` and `pending`). The source skips `errored` streams the same way it skips `complete` ones. Eof fires when all streams are either `complete` or `errored`.

The second option is cleaner — it preserves the distinction between "successfully synced" and "gave up on this stream." The child workflow treats `errored` streams as failures in its final evaluation.

### Error classification

Reclassify the catch-all `system_error` into genuinely transient vs. deterministic:

| Error                        | Current type      | Proposed type                 |
| ---------------------------- | ----------------- | ----------------------------- |
| Rate limit (429)             | `transient_error` | `transient_error` (no change) |
| Auth (401/403)               | `auth_error`      | `auth_error` (no change)      |
| Network timeout / ECONNRESET | `system_error`    | `transient_error`             |
| Stripe 5xx                   | `system_error`    | `transient_error`             |
| JSON parse failure           | `system_error`    | `system_error` → permanent    |
| Connector bug (bad params)   | `system_error`    | `system_error` → permanent    |
| Unknown stream               | `config_error`    | `config_error` (no change)    |

```ts
const PERMANENT_FAILURE_TYPES = new Set(['config_error', 'auth_error', 'system_error'])
```

```ts
function classifyError(err: unknown): TraceError['failure_type'] {
  if (err instanceof StripeApiRequestError) {
    if (err.status === 401 || err.status === 403) return 'auth_error'
    if (err.status === 429) return 'transient_error'
    if (err.status >= 500) return 'transient_error'
  }
  if (isNetworkError(err)) return 'transient_error'
  if (err instanceof Error && err.message.includes('Rate limit')) return 'transient_error'
  return 'system_error' // deterministic by default
}
```

Only `transient_error` is worth retrying. Everything else is permanent — but the stream still gets marked `errored` (not retried within the same backfill run), and other streams continue.

### Preserve `failure_type` through `collectMessages`

Today `collectMessages` throws a plain `Error`, discarding `failure_type`. So `pipelineSetup` retries a `config_error` the same as a network blip.

```ts
export class TraceErrorException extends Error {
  constructor(
    public readonly failure_type: TraceError['failure_type'],
    message: string,
    public readonly stream?: string
  ) {
    super(message)
    this.name = 'TraceErrorException'
  }
}
```

## `pipelineWorkflow` — the never-fail entity

The pipeline workflow is the parent. It contains two loops: a **backfill loop** that spawns `pipelineBackfillWorkflow` child workflows, and a **live loop** that processes events via activities. The backfill loop handles both initial backfill and periodic reconciliation — same child workflow, different starting state.

```ts
export async function pipelineWorkflow(
  pipelineId: string,
  opts?: PipelineWorkflowOpts
): Promise<void> {
  let desiredStatus = opts?.desiredStatus ?? 'active'
  let sourceState = opts?.sourceState ?? { streams: {}, global: {} }
  let state: PipelineWorkflowState = { ...opts?.state }
  // ... signal handlers, setState, etc.

  // Setup
  if (state.setup !== 'completed') {
    await setState({ setup: 'started' })
    await pipelineSetup(pipelineId)
    await setState({ setup: 'completed' })
  }

  // Initial backfill — spawn child, catch failure
  if (state.phase !== 'ready') {
    await setState({ phase: 'backfilling' })
    try {
      sourceState = await executeChild(pipelineBackfillWorkflow, {
        workflowId: `backfill-${pipelineId}`,
        args: [pipelineId, { state: sourceState }],
      })
      await setState({ phase: 'ready' })
    } catch (err) {
      await markPermanentError(extractErrorDetails(err))
    }
  }

  // Main loop
  while (desiredStatus !== 'deleted') {
    if (state.errored) {
      await waitForErrorRecovery()
      continue
    }
    if (desiredStatus === 'paused') {
      await waitForResume()
      continue
    }

    await Promise.all([
      liveLoop(),
      backfillLoop(), // spawns pipelineBackfillWorkflow children on a schedule
    ])

    if (shouldContinueAsNew()) {
      await continueAsNew<typeof pipelineWorkflow>(pipelineId, {
        desiredStatus,
        sourceState,
        state,
      })
    }
  }

  // Teardown
  await setState({ teardown: 'started' })
  await pipelineTeardown(pipelineId)
  await setState({ teardown: 'completed' })
}
```

### `liveLoop` — activities in the parent

Live events stay as activity calls in the parent workflow. Permanent errors park the workflow.

```ts
async function liveLoop(): Promise<void> {
  while (true) {
    const events = await waitForLiveEvents()
    if (!events) return

    const result = await pipelineSync(pipelineId, { input: events })
    if (result.errors.length > 0) {
      const { permanent } = classifySyncErrors(result.errors)
      if (permanent.length > 0) {
        await markPermanentError(permanent)
        return
      }
    }
  }
}
```

### `backfillLoop` — the loop in the parent that spawns child workflows

This is _not_ a separate workflow — it's a function inside `pipelineWorkflow` that periodically spawns `pipelineBackfillWorkflow` child workflows. Each child is an independent run.

```ts
async function backfillLoop(): Promise<void> {
  while (!runInterrupted()) {
    await condition(() => reconcileRequested || runInterrupted(), ONE_WEEK_MS)
    if (runInterrupted()) return

    await setState({ phase: 'reconciling' })
    try {
      sourceState = await executeChild(pipelineBackfillWorkflow, {
        workflowId: `reconcile-${pipelineId}-${Date.now()}`,
        args: [pipelineId, { state: sourceState }],
      })
      await setState({ phase: 'ready' })
    } catch (err) {
      await markPermanentError(extractErrorDetails(err))
      return
    }
  }
}
```

### Recovery signals

| Signal                   | Trigger                | Workflow action                                    |
| ------------------------ | ---------------------- | -------------------------------------------------- |
| `desired_status: active` | User re-enables        | Clear errored state, re-enter main loop (existing) |
| `credentials_updated`    | User rotates API key   | Clear if `auth_error`                              |
| `config_updated`         | User modifies config   | Clear, re-run setup if needed                      |
| `deployment_updated`     | New connector deployed | Clear if `system_error`                            |

After recovery, the parent spawns a new `pipelineBackfillWorkflow` that resumes from the last checkpointed `sourceState`. Previously-completed streams are skipped. Previously-errored streams are retried (their state resets from `errored` to `pending`). Streams that were in-flight when the child failed resume from their last cursor.

## Observability

- **Is the backfill done?** → `backfill-{pipelineId}` workflow status: completed / failed / running
- **Why did it fail?** → child workflow failure has full error list: which streams failed, why
- **How long did backfill take?** → child workflow start/end timestamps
- **Which reconcile runs happened?** → list child workflows matching `reconcile-{pipelineId}-*`
- **Did some streams succeed despite the failure?** → yes, `sourceState` shows which streams are complete

## Implementation order

### Phase 1: Activity always returns errors

Highest impact, prerequisite for everything else.

1. Modify `pipeline-sync.ts`: always return `{ errors, state, eof }`, never throw
2. Update `pipelineWorkflow` to handle transient errors from the activity (the current `reconcileLoop` and `liveLoop` need to classify errors instead of relying on the throw)
3. For now, permanent errors still stop the loop (existing `markPermanentError` behavior)

### Phase 2: Add `errored` stream status to source

Enable per-stream error isolation.

1. Add `errored` status alongside `complete` and `pending` in source state
2. Update `listApiBackfill`: on non-retryable error, mark stream as `errored` and continue
3. Eof fires when all streams are `complete` or `errored`
4. `pipelineSync` returns errors for `errored` streams but keeps going

### Phase 3: Extract `pipelineBackfillWorkflow` child workflow

1. Create `apps/service/src/temporal/workflows/pipeline-backfill-workflow.ts`
2. Register in worker alongside `pipelineWorkflow`
3. Accumulate errors across chunks, evaluate at eof
4. Throw `ApplicationFailure.nonRetryable` if permanent errors exist

### Phase 4: Rewire `pipelineWorkflow`

1. Replace inline `reconcileLoop` with `backfillLoop` function that spawns `pipelineBackfillWorkflow` children
2. Add try/catch for `ChildWorkflowFailure` → `markPermanentError`
3. Keep `liveLoop` as activities in the parent
4. Simplify `continueAsNew` payload

### Phase 5: Reclassify `system_error`

1. Add `isNetworkError` helper
2. Update `classifyError` in source connector
3. Expand `PERMANENT_FAILURE_TYPES` to include `system_error`
4. Update tests

### Phase 6: Preserve `failure_type` through `collectMessages`

1. Add `TraceErrorException` to `packages/protocol`
2. Update `collectMessages` to throw it
3. Update `pipelineSetup` activity to use `nonRetryableErrorTypes`

### Phase 7: Recovery signals (additive)

1. Define new signals in `_shared.ts`
2. Add handlers in `pipelineWorkflow`
3. Wire to service API endpoints

### Migration

Phase 1 ships without versioning concerns — same workflow shape, different activity behavior. Phase 3–4 (child workflow extraction) requires migration: deploy new code, existing workflows `continueAsNew` into the new shape. The new `pipelineWorkflow` accepts the old `PipelineWorkflowOpts` — if `state.phase === 'backfilling'` and no child is running, spawn a `pipelineBackfillWorkflow`.

## Constants

```ts
const BACKFILL_CONTINUE_AS_NEW_THRESHOLD = 500 // for pipelineBackfillWorkflow
const PIPELINE_CONTINUE_AS_NEW_THRESHOLD = 1000 // pipeline is lighter now
const MAX_TRANSIENT_RETRIES = 5 // for transient errors in liveLoop
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000 // reconcile schedule
```

## Open questions

1. **Should the parent pause live events during initial backfill?** Currently live and reconcile run in parallel. Should we avoid writing to the same streams from both paths?
2. **Per-stream child workflows (future)?** This plan has one child for all streams. A future iteration could spawn per-stream children for fully independent lifecycle management.
3. **Backfill progress reporting.** With a child workflow, we could report progress (e.g., "47/50 streams complete, 2 errored, 1 in progress") via Temporal queries.
4. **Child workflow survival across `continueAsNew`.** Child workflows don't carry over when the parent continues-as-new. Use deterministic workflow IDs so the parent can re-attach.
5. **Transient errors in `pipelineBackfillWorkflow`.** If a stream has a transient error in one chunk, should the child retry it in the next chunk (since the stream stays `pending`)? Or should transient errors that persist across N chunks escalate to `errored`?
