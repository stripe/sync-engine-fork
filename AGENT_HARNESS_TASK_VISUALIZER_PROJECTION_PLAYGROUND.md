# Agent Harness Task: Visualizer Projection Playground

## Mission

Add a projection-playground experience to the ERD in `packages/visualizer` so the user can explore alternate schema-projection heuristics client-side.

This work is about the ERD product experience, not a broad rewrite of the OpenAPI parser.

The key constraint is:

- keep the feature logic in `packages/visualizer`
- allow only minimal build-time injection into the existing OpenAPI/parser/build flow
- do not generate a Cartesian product of static artifacts

## North Star

The visualizer should let the user load one browser-safe schema artifact for a chosen API version, then interactively toggle how that schema is interpreted in the ERD.

The ERD should feel like a projection playground:

- one canonical schema artifact per API version
- one lightweight projection sidecar per API version
- instant client-side toggles
- no rebuild or page reload for every projection mode switch

## Non-Negotiables

- Keep the main product code in `packages/visualizer`.
- Do not move projection scenario logic into `packages/sync-engine/src/openapi/*`.
- Minimal changes outside `packages/visualizer` are allowed only when required for build-time metadata generation or orchestration.
- Do not generate `n * n * n` projection artifact combinations.
- Keep the runtime browser-only and client-side.
- Do not introduce API routes, server rendering tricks, or a remote database layer.
- Do not parse `bootstrap.sql` in the browser.
- Do not break the existing explorer flow while adding this ERD-focused feature.

## Core Product Requirement

This task is ERD-first.

The configurable projection modes must drive the ERD experience.

For this task, the SQL Explorer tab may remain bound to the canonical hydrated schema if that keeps the implementation simple and clean. The harness should not try to make the Explorer tab pretend that the underlying SQL schema changed unless doing so is nearly free.

## Required Projection Scenarios

The ERD must support these scenario axes.

### 1. Object namespace mode

Support these exclusive values:

- `all`
- `v1`
- `v2`
- `both`

Semantics:

- `all` means the current full projected schema view, including tables that are not cleanly classed as `v1` or `v2`.
- `v1` means only tables backed by `v1` resource provenance.
- `v2` means only tables backed by `v2` resource provenance.
- `both` means the union of tables classed as `v1` or `v2`, excluding miscellaneous unclassified or purely compatibility-only tables unless they are explicitly required by the visible projection model.

The harness must make the distinction between `all` and `both` meaningful.

### 2. Physical FK mode

Support these exclusive values:

- `no`
- `yes`

Semantics for this task:

- `no` means the current ERD-without-relationships experience.
- `yes` means the projection model should include relationship edges and the default layout should use them.

Important:

- The harness should not multiply SQL artifacts just to encode alternate FK DDL.
- It is acceptable for `physical FKs = yes` to be represented by projection metadata plus ERD layout/edge behavior rather than actual alternate `bootstrap.sql` files.
- If actual FK DDL can be preserved safely in the canonical artifact without harming browser hydration, that is acceptable, but it is not required.

### 3. Timestamp mode

Support these exclusive values:

- `raw`
- `timestamptz`

Semantics:

- `raw` means current projected types.
- `timestamptz` means v1 `created` or timestamp-like epoch-second columns should render as `timestamptz` in the ERD projection.
- v2 objects already tend to use timestamp strings and should continue to render naturally.

This should be driven by semantic metadata, not scattered hardcoded table-name checks.

### 4. Deleted-resource mode

Support these exclusive values:

- `column`
- `table`

Semantics:

- `column` means keep the current style where deleted state lives on the base table when relevant.
- `table` means render deleted-resource variants as separate deleted tables where the upstream schema supports them.

Important:

- Do not generate separate SQL bootstraps just for deleted-table mode.
- The harness may synthesize virtual deleted tables in the ERD projection model.
- In deleted-table mode, the harness should avoid showing both a deleted-only table and a redundant deleted flag on the main table unless that duplication is intentionally justified.

## Architecture Decision

Use one canonical browser schema artifact plus one projection sidecar artifact per API version.

Do not create one SQL artifact per projection combination.

The harness should add a sidecar like:

```text
packages/visualizer/public/explorer-data/
  <api-version>/
    bootstrap.sql
    manifest.json
    projection.json
```

The visualizer should fetch `projection.json` and derive the active ERD model client-side from:

- the selected version
- the selected projection config
- the canonical manifest data

## Where Code Should Live

The desired ownership split is:

- `packages/visualizer/src/*`
  - projection config state
  - projection derivation logic
  - floating controls UI
  - ERD rendering changes
  - any visualizer-side hooks/types for `projection.json`
- `packages/visualizer/build/*`
  - build-time projection artifact generation helpers
- `scripts/*`
  - only thin orchestration changes needed to invoke visualizer build helpers
- `packages/sync-engine/src/openapi/*`
  - only minimal raw metadata exposure if the existing parser/build flow does not currently surface enough provenance

The harness must not place projection scenario logic in `sync-engine`.

## Build-Time Injection Rule

It is acceptable to inject minimal build-time hooks into the existing OpenAPI parser/build flow when `explorer-migrate` or `explorer-export` runs.

Examples of acceptable minimal sync-engine changes:

- exposing parser provenance needed by the visualizer artifact generator
- exposing raw resource namespace tags
- exposing deleted-resource linkage
- exposing timestamp semantic hints

Examples of unacceptable sync-engine changes:

- moving scenario toggles into parser runtime code
- adding visualizer-specific UI policy to the parser
- creating multiple migration modes solely for visualizer combinations

## Projection Artifact Requirements

`projection.json` should be lightweight but sufficient for all four scenario axes.

At a minimum it should include:

- per-table provenance
- per-column semantic hints
- relationship candidates
- deleted-resource metadata
- version capabilities

Suggested shape:

```ts
type ProjectionArtifact = {
  apiVersion: string
  generatedAt: string
  capabilities: {
    hasV2Tables: boolean
    hasDeletedVariants: boolean
    hasRelationshipCandidates: boolean
  }
  tables: Array<{
    tableName: string
    resourceId: string
    sourceSchemaName: string
    namespace: 'v1' | 'v2' | 'unknown'
    familyKey: string
    isCompatibilityOnly: boolean
    isDeletedVariant: boolean
    columns: Array<{
      name: string
      materializedType: string
      logicalType: string
      nullable: boolean
      expandableReference?: boolean
      semanticTags: string[]
    }>
  }>
  relationships: Array<{
    fromTable: string
    fromColumn: string
    toTable: string
    toColumn: string
    source: string
    confidence: 'high' | 'medium' | 'low'
  }>
  deletedVariants: Array<{
    baseTable: string
    deletedTable: string
    sourceSchemaName: string
  }>
}
```

The exact format may differ, but the artifact must be clean, documented, and intentionally minimal.

## ERD Runtime Model

The ERD should stop depending exclusively on live `information_schema` introspection for its visible model.

The harness should refactor the ERD so that:

- canonical PGlite hydration still happens as it does today
- the ERD view loads `projection.json`
- the ERD derives its visible nodes and edges from the active projection config
- toggling projection config recomputes the ERD model and re-runs layout without rehydrating PGlite

It is acceptable to keep the live schema utilities around for fallback or debugging, but the projection playground must not rely on runtime DB introspection alone.

## UI Requirement

Add a floating configuration surface inside the ERD.

Required behavior:

- it appears as a hoverable or clickable floating container
- it stays usable while panning/zooming the canvas
- it exposes the four exclusive option groups
- it clearly shows the active selection
- changing an option updates the ERD immediately
- layout should rerun when FK mode or visible table set changes

Do not make the control so hover-fragile that it disappears during normal use.

A compact collapsed pill or button that expands into a small control card is preferred.

## Config State Model

The harness should model each axis as an exclusive enum, not a pile of booleans.

Preferred shape:

```ts
type ProjectionConfig = {
  namespaceMode: 'all' | 'v1' | 'v2' | 'both'
  fkMode: 'no' | 'yes'
  timestampMode: 'raw' | 'timestamptz'
  deletedMode: 'column' | 'table'
}
```

The visualizer should own this state near the top of the ERD flow so the canvas and controls stay synchronized.

## Version Caveat

The current version matrix may not include a version with v2 coverage.

The harness must address this explicitly.

Acceptable approaches:

- replace the latest supported version with a resolvable snapshot at or after `2026-01-28`
- add one supported version at or after `2026-01-28` if the supported-version policy still stays intentional
- disable `v2` and `both` options for versions whose projection artifact contains no v2-backed tables

Preferred outcome:

- at least one supported version should make the `v2` projection modes genuinely demonstrable

## Scope Guard

This task is not permission to:

- rewrite the full migration system
- fork or duplicate the OpenAPI parser in the browser
- add one artifact per projection combination
- make the Explorer tab projection-aware unless it is trivially cheap
- refactor unrelated sync-engine internals

## Acceptance Criteria

- One canonical `bootstrap.sql` remains the source of hydrated browser data per API version.
- One additional `projection.json` sidecar is generated per API version.
- The ERD can switch among the four projection axes without rebuilding artifacts.
- The floating control panel exists and is usable in the live ERD.
- Namespace filtering works for `all`, `v1`, `v2`, and `both`.
- FK mode `yes` visibly adds relationship lines and changes layout behavior.
- Timestamp mode `timestamptz` changes relevant v1 column rendering in the ERD.
- Deleted mode `table` can render deleted resources as separate virtual tables when supported.
- The implementation remains primarily in `packages/visualizer`.
- Any non-visualizer changes remain minimal and justified.

## Verification

The harness should not declare success until it verifies all of the following.

### Artifact verification

- Run the versioned explorer build flow.
- Confirm `projection.json` is emitted alongside `bootstrap.sql` and `manifest.json`.
- Confirm there is still only one canonical bootstrap artifact per version.

### ERD verification

- Start the visualizer locally.
- Open the ERD.
- Confirm the floating projection controls are present.
- Toggle each projection axis and confirm the ERD updates without a full DB reload.
- Confirm FK mode `yes` adds relationship lines and influences layout.
- Confirm timestamp mode changes relevant displayed types.
- Confirm deleted mode changes how deleted resources appear in the ERD.

### Version verification

- Switch across supported versions.
- Confirm version switching still rehydrates the correct artifact set.
- Confirm versions without v2 data behave intentionally, either by disabling the control or showing an empty-but-explained state.
- Confirm at least one version demonstrates a non-empty v2 projection mode, or explicitly document why that was deferred.

## Done Means

This task is done when:

- the ERD is a client-side projection playground
- the implementation stays centered in `packages/visualizer`
- the build produces one projection sidecar per version instead of a combinatorial artifact matrix
- the UI exposes clean exclusive controls for namespace, FKs, timestamps, and deleted-resource interpretation
- the solution is simple, intentional, and browser-safe

## Suggested Commands

The harness may adjust commands as needed, but the end state should support a workflow equivalent to:

```bash
pnpm explorer:build --api-version=2026-02-25
pnpm explorer:build:all
pnpm visualizer
```
