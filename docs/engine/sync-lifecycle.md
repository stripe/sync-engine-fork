# Sync Lifecycle

How sync runs work: run identity, state ownership, time ranges, and stall
detection. For message types and connector interfaces, see [protocol.md](./protocol.md).

## Motivation

The base protocol treats each `read()` call as independent. The caller manages
pagination (via `state_limit`), upper bounds, and retry policy externally. This
creates several problems:

1. **Backfill bounds shift between calls.** Each call computes `now()` as the
   upper bound, so high-volume accounts chase a moving target and never converge.
2. **No run identity.** Multiple calls that form one logical backfill have no
   shared context. The engine cannot distinguish "continuation" from "new sync."
3. **Source owns retry policy.** Error types are baked into source state, mixing
   cursor data with skip-on-resume decisions.
4. **Engine duplicates source bookkeeping.** Stream status and errors are tracked
   independently by source and engine, with divergent representations.
5. **Stalled streams are invisible.** A non-incremental stream that restarts
   every run blocks other streams with no detection or mitigation.

This design introduces **sync runs** as a first-class concept and moves time
range management, stream lifecycle guarantees, and stall detection to the engine.

---

## Layers

```
CLIENT  ←—start/end—→  ENGINE  ←—iterator—→  SOURCE
```

| Concern                      | Client                 | Engine                                    | Source                              |
| ---------------------------- | ---------------------- | ----------------------------------------- | ----------------------------------- |
| What to sync (streams)       | Provides catalog       | Adjusts catalog (time_range, deprioritize)| Syncs what it's given               |
| When to sync (scheduling)    | Decides                | —                                         | —                                   |
| Run identity                 | Generates sync_run_id  | Freezes bounds, tracks continuations      | Unaware                             |
| Time range bounds            | —                      | Computes, injects into catalog            | Respects `time_range` if present    |
| Internal segmentation        | —                      | —                                         | Manages segments, parallel pages    |
| Stream lifecycle             | Consumes progress      | Guarantees terminal status                | Emits `started`, optionally `complete` |
| Progress reporting           | Consumes               | Enriches source signals, emits progress   | Emits raw stream_status + records   |
| Error reporting              | Decides retry policy   | Passes through, tracks for stalls         | Emits trace errors                  |
| State                        | Opaque round-trip      | Manages engine section                    | Manages source section              |
| Stall detection              | —                      | Tracks per-stream across runs             | —                                   |
| `has_more`                   | Reads, acts            | Derives from source + engine state        | —                                   |

---

## Messages

### `start` — client → engine

Begins or continues a sync run. See [Types](#types) for `StartPayload`.

### `end` — engine → client

The run is done. See [Types](#types) for `EndPayload`.

`has_more: true` — send another `start` with the same `sync_run_id` and the
returned `state`. `has_more: false` — this run is complete; use a new
`sync_run_id` for the next sync.

### Source → engine

Sources are iterators that yield these message types:

```ts
// Data record
{ type: 'record', record: { stream: string, data: Record<string, unknown>, emitted_at: string } }

// Checkpoint (per-stream — most common)
// time_range tells the engine which range this checkpoint belongs to.
// When data has no cursor (pagination done), engine marks this range as synced.
{ type: 'source_state', source_state: { state_type: 'stream', stream: string, time_range?: { gte: string, lt: string }, data: unknown } }

// Checkpoint (global — e.g. events cursor shared across all streams)
{ type: 'source_state', source_state: { state_type: 'global', data: unknown } }

// Lifecycle signal
{ type: 'trace', trace: { trace_type: 'stream_status', stream_status: { stream: string, status: 'started' | 'complete' } } }

// Error — discriminated union on error_level (see Error Handling)
{ type: 'trace', trace: { trace_type: 'error', error: SyncError & { stack_trace?: string } } }

// Diagnostic log
{ type: 'log', log: { level: 'debug' | 'info' | 'warn' | 'error', message: string } }
```

### Engine → client

The engine emits three message types: `progress`, `record`, and `end`.

```ts
// Progress — emitted on every source_state checkpoint and stream_status change.
// Each message is a complete snapshot of run-level progress.
// All counts are cumulative since the start of the run (across requests with
// the same sync_run_id). Client can diff consecutive messages for deltas.
{
  type: 'progress',
  progress: {
    elapsed_ms: number,                       // wall-clock since run started (across all requests)
    global_state_count: number,               // total checkpoints this run (all streams)
    rates: {
      records_per_second: number,
      states_per_second: number,
    },
    streams: Record<string, StreamProgress>,
    errors: SyncError[]
  }
}

// Records — passed through from source
{ type: 'record', record: { stream: string, data: Record<string, unknown>, emitted_at: string } }

// Terminal — this request is done.
// end.request has the same shape as progress but scoped to this request only.
{
  type: 'end',
  end: {
    has_more: boolean,
    state: SyncState,
    request_progress: ProgressPayload,                 // same shape, scoped to this request
  }
}
```

`ProgressPayload` is used in two places with different scopes:

| Scope                     | Where to find it                              |
| ------------------------- | --------------------------------------------- |
| Between two progress msgs | Client diffs consecutive `progress` messages  |
| This request              | `end.request_progress` (ProgressPayload)      |
| This run (across requests)| Latest `progress` message (ProgressPayload)   |
| All time (across runs)    | Sum of `completed_ranges` coverage + segment counts |

The engine does NOT emit trace messages to the client. Errors are included
per-segment inside `progress`. Source traces and logs are consumed by the engine
and distilled into `progress`.

---

## Stream Status

Source emits `stream_status` trace messages with `started` and `complete` per
stream. The engine uses these to know when a stream is active.

A stream's backfill is done when `completed_ranges` covers the full range
`[0, started_at)`.

The source manages segments internally — the engine doesn't see or track them.
The engine learns about completed ranges from `source_state` messages that
include a `time_range` and have no remaining cursor.

Errors are orthogonal to lifecycle. A stream can be `complete` with errors
(some pages failed but the stream moved past them) or `incomplete` without
errors (time limit hit mid-stream).

---

## Types

### Configured catalog (client → engine → source)

The client provides the catalog. The engine adjusts it (injects `time_range`)
before passing to the source.

```ts
type ConfiguredStream = {
  stream: {
    name: string                              // e.g. "customers", "invoices"
    primary_key: string[][]                   // e.g. [["id"]]
    json_schema?: Record<string, unknown>
    metadata?: Record<string, unknown>        // e.g. { api_version, account_id, live_mode }
  }
  sync_mode: 'full_refresh' | 'incremental'
  destination_sync_mode: 'append' | 'overwrite' | 'append_dedup'
  cursor_field?: string[]
  fields?: string[]                           // field projection
  backfill_limit?: number                     // cap backfill to N records
  system_columns?: Array<{ name: string; type: string; index: boolean }>

  // NEW — set by engine, not client
  time_range?: {
    gte: string                               // inclusive lower bound (ISO 8601)
    lt: string                                // exclusive upper bound (ISO 8601)
  }
}

type ConfiguredCatalog = {
  streams: ConfiguredStream[]
}
```

### Start message (client → engine)

```ts
type StartPayload = {
  sync_run_id: string                         // client-generated UUID
  source_config: Record<string, unknown>      // source-specific (e.g. Stripe API key, account)
  destination_config: Record<string, unknown> // destination-specific (e.g. Postgres connection)
  configured_catalog: ConfiguredCatalog
  state?: SyncState                           // from previous end; omit on first sync
}
```

### End message (engine → client)

```ts
type EndPayload = {
  has_more: boolean
  state: SyncState                            // round-trip into next start
  request: ProgressPayload                    // stats for this request only (same shape as progress)
}
```

### Progress message (engine → client)

Emitted on every `source_state` checkpoint and `stream_status` change. Each
message is a complete snapshot of run-level progress — the client never needs
a reducer.

```ts
// Errors are a discriminated union on error_level.
type SyncError =
  | { error_level: 'global';    message: string }
  | { error_level: 'stream';    message: string; stream: string }
  | { error_level: 'transient'; message: string; stream?: string }

type StreamProgress = {
  completed_ranges?: Array<{ gte: string; lt: string }>  // merged completed time ranges
  record_count: number                                    // records this run (across requests)
  state_count: number                                     // checkpoints this run for this stream
}

type ProgressPayload = {
  elapsed_ms: number                          // wall-clock since run started (across requests)
  global_state_count: number                  // total checkpoints this run (all streams)
  rates: {                                    // derived, computed by engine
    records_per_second: number
    states_per_second: number
  }
  streams: Record<string, StreamProgress>     // keyed by stream name
  errors: SyncError[]                         // all errors accumulated this run
}
```

### SyncState (round-tripped between start and end)

```ts
type SyncState = {
  source: SourceState                         // opaque to engine — cursor data
  engine: EngineState                         // opaque to client — run progress + run identity
}

type SourceState = {
  streams: Record<string, unknown>            // per-stream cursor data, keyed by stream name
  global: Record<string, unknown>             // source-wide data (e.g. events cursor)
}

// Engine state is run progress + run identity. Same ProgressPayload shape
// used in progress messages, extended with run tracking fields.
type EngineState = ProgressPayload & {
  sync_run_id: string                         // current run ID
  started_at: string                          // ISO 8601 — frozen snapshot upper bound
}
```

### Source state — Stripe example

Pure cursor data. No error types, no status field. The engine treats this as
opaque; the types below are source-internal.

```ts
// Per-stream state (source-internal, opaque to engine)
// Minimal — just a pagination cursor. Range management is engine's job.
type StripeStreamState = {
  page_cursor: string | null                  // Stripe list pagination cursor
}
```

The source receives `time_range` from the catalog and paginates within it.
The engine tracks which ranges are complete and which need work via
`completed_ranges` and `pending_ranges` in engine state.

**Example — two streams mid-sync:**
```jsonc
{
  "source": {
    "streams": {
      "customers": { "page_cursor": "cus_xyz" },
      "invoices": { "page_cursor": null }
    },
    "global": {
      "events_cursor": "2024-04-16T23:50:00Z"
    }
  }
}
```

### Engine state

The engine state is `ProgressPayload` extended with run identity. The client
round-trips it opaquely. The engine uses it to accumulate progress across
requests within a run and to track synced ranges across runs.

```ts
type EngineState = ProgressPayload & {
  sync_run_id: string
  started_at: string                          // ISO 8601 — frozen snapshot upper bound
}
```

**Example — customers fully synced through 2023, invoices mid-backfill, big_table stalled:**
```jsonc
{
  "engine": {
    "sync_run_id": "sr_abc",
    "started_at": "2024-04-17T00:00:00Z",
    "elapsed_ms": 8400,
    "global_state_count": 24,
    "records_per_second": 5500,
    "states_per_second": 2.9,
    "streams": {
      "customers": {
        "completed_ranges": [{ "gte": "2018-01-01T00:00:00Z", "lt": "2024-04-17T00:00:00Z" }],
        "record_count": 45000,
        "state_count": 16
      },
      "invoices": {
        "completed_ranges": [{ "gte": "2018-01-01T00:00:00Z", "lt": "2021-06-01T00:00:00Z" }],
        "record_count": 1200,
        "state_count": 8
      },
      "big_table": {
        "completed_ranges": [],
        "record_count": 0,
        "state_count": 0
      }
    }
  }
}
```

---

## Sync Runs

A sync run is identified by `sync_run_id`. Within a run, the upper time bound
(`started_at`) is frozen.

### New run

1. Client sends `start` with a new `sync_run_id`.
2. Engine freezes `started_at = now()` and stores it in engine state.
3. Engine computes `time_range` for each stream:
   - Upper bound: `started_at`
   - Lower bound: end of last `completed_ranges` entry (or account creation for
     first backfill)
4. Engine injects `time_range` into configured catalog before passing to source.
5. Source syncs within the given range, yields messages, exhausts.
6. Engine emits progress, pipes records to destination, returns `end`.

### Continuation

1. Client sends `start` with the same `sync_run_id` and `state` from previous `end`.
2. Engine sees same ID — preserves `started_at` from engine state.
3. Engine sets the same `time_range` (same frozen upper bound).
4. Source resumes from its cursor state within the same range.

### Completion

When `has_more: false`:
- All streams completed their ranges or were marked `incomplete`.
- Engine promotes completed `pending_range` entries to `completed_ranges`.
- Client should use a new `sync_run_id` for the next sync.

### Example

```
sync_run_id: "sr_1"
  request 1:  customers [2018, 2024)         → timed out → end { has_more: true }
  request 2:  customers [2018, 2021)          → completed
              customers [2021, 2024)          → timed out → end { has_more: true }
  request 3:  customers [2021, 2022.5)        → completed
              customers [2022.5, 2024)        → completed → end { has_more: false }
              completed_ranges merges to [2018, 2024) ✓
```

Each run's upper bound is frozen. Ranges that don't complete get subdivided.
Completed adjacent ranges merge.

---

## Time Ranges

Time is a first-class concept. The engine sets the outer bounds; the source
manages pagination and segmentation within them.

### Flow

```
Client catalog:     { stream: "customers", sync_mode: "incremental" }
                    (no time_range — client doesn't set this)
                                ↓
Engine sets range:  { stream: "customers", sync_mode: "incremental",
                      time_range: { gte: "2021-01-01T00:00:00Z", lt: "2024-04-17T00:00:00Z" } }
                    (computed from completed_ranges + started_at)
                                ↓
Source receives:    time_range on configured stream.
                    Manages its own segments/subdivision/parallelism within it.
                    Emits source_state with time_range to report range completion.
```

### How the engine tracks completed ranges

The engine observes `source_state` messages. When a state message includes
`time_range` and has no remaining cursor, the engine knows that range is done
and adds it to `completed_ranges`, merging adjacent ranges:

```
completed_ranges: [{ gte: "2018", lt: "2021" }]
+ source_state with time_range [2021, 2024), cursor: null
= completed_ranges: [{ gte: "2018", lt: "2024" }]   (merged)
```

### Engine range computation

On each request, the engine computes the `time_range` to assign:

1. Upper bound: `started_at` (frozen for the run)
2. Lower bound: end of last `completed_ranges` entry (or account start for first backfill)
3. If `completed_ranges` has gaps, fill the first gap

### Why this matters

- **Frozen upper bounds.** `started_at` does not move within a run.
- **Adaptive parallelism.** Dense ranges get subdivided; sparse ranges complete in one shot.
- **Visibility.** Engine knows what fraction of history is synced.
- **Compact state.** Merged ranges keep state O(active segments), not O(total history).

---

## `has_more` Derivation

The engine derives `has_more` at end of run:

```
has_more = true if any catalog stream where:
  - source state has a page_cursor (mid-pagination), OR
  - completed_ranges don't cover [0, started_at)
```

---

## Error Handling

### Error levels

Errors carry their blast radius. The `error_level` determines the engine's action:

| `error_level` | Blast radius | Engine action | Example |
|---|---|---|---|
| `global` | Entire sync | Abort all streams, `has_more: false` | Invalid API key, bad source config |
| `stream` | One stream | Skip stream, continue others | Resource not available, permission denied |
| `transient` | One request | Informational | Rate limited, retried 3x in 4.2s |

### Source → engine error flow

```ts
// Source emits trace errors — discriminated union on error_level:
{ type: 'trace', trace: { trace_type: 'error', error: SyncError } }

// Examples:
{ error: { error_level: 'global', message: 'Invalid API key' } }
{ error: { error_level: 'stream', message: 'Not available in test mode', stream: 'invoices' } }
{ error: { error_level: 'transient', message: 'Rate limited, retried 3x', stream: 'customers' } }
```

The source decides the `error_level`:
- **Transient**: Request failed and retried — emit for observability.
- **Stream**: Stream-level failure (e.g. resource not enabled) — skip stream.
- **Global**: Unrecoverable (e.g. invalid credentials) — stop everything.

### Engine behavior

The engine accumulates errors into `progress.errors[]` and acts on them:

- **`global`**: Stop the source, emit `end { has_more: false }`.
- **`stream`**: Skip that stream, continue others.
- **`transient`**: No action. Included in `progress.errors` for observability.

Errors are NOT stored in source state. Segment-level concerns (subdivision,
retries, timeouts) are managed internally by the source.

---

## Wire Format

NDJSON. One message per line.

```
→  {"type":"start","sync_run_id":"sr_abc","source_config":{...},"configured_catalog":{...}}
←  {"type":"progress","progress":{"elapsed_ms":100,"global_state_count":0,"records_per_second":0,"states_per_second":0,"streams":{"customers":{"completed_ranges":[],"record_count":0,"state_count":0}},"errors":[]}}
←  {"type":"record","record":{"stream":"customers","data":{...}}}
←  {"type":"progress","progress":{"elapsed_ms":1600,"global_state_count":1,"records_per_second":1562,"states_per_second":0.6,"streams":{"customers":{"completed_ranges":[],"record_count":2500,"state_count":1}},"errors":[]}}
←  {"type":"record","record":{"stream":"customers","data":{...}}}
←  {"type":"progress","progress":{"elapsed_ms":3200,"global_state_count":2,"records_per_second":1562,"states_per_second":0.6,"streams":{"customers":{"completed_ranges":[{"gte":"2018-01-01T00:00:00Z","lt":"2024-04-17T00:00:00Z"}],"record_count":5000,"state_count":2}},"errors":[]}}
←  {"type":"end","has_more":false,"state":{"source":{...},"engine":{...}}}
```

Over HTTP: POST with NDJSON body (one `start` line), NDJSON response stream.
Clients that don't want streaming buffer until `end`.

---

## Client Loop

```ts
let state = undefined
const syncRunId = crypto.randomUUID()

do {
  const { end } = await engine.sync({
    sync_run_id: syncRunId,
    source_config,
    destination_config,
    configured_catalog,
    state,
  })
  state = end.state
} while (end.has_more)

// Backfill complete. Schedule next sync with a new sync_run_id.
```

The client does not need to understand stream statuses, error classification,
time ranges, or stall detection. It sends config + state, gets back
`has_more` + state. Everything else is in the progress stream for observability.
