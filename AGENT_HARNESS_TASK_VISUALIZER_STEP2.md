# Agent Harness Task: Visualizer Step 2

## Mission

Update `packages/visualizer` with an ERD, and make it API version-aware. Keep all exploration client-side through PGlite.

Existing Table/Result/SQL view should not break. This is new functionality.

The work must happen in this order:

1. ERD tab and ERD experience
2. Version picker backed by 5 pre-generated artifacts
3. Roughly 5x more realistic fake data

Do not reorder these phases.

## North Star

The visualizer should become a polished schema exploration tool where:

- the first-class experience is an ERD canvas, not just a SQL table browser
- the loaded "schema" can be swapped between a small, intentional set of supported Stripe API versions.
- the data is dense enough to feel realistic without abandoning the repo's OpenAPI projection logic

## Non-Negotiables

- Keep the primary product work in `packages/visualizer`.
- Do not touch `packages/dashboard`.
- Only change code outside `packages/visualizer` when it is strictly required for artifact generation, schema metadata export, or multi-version build orchestration.
- Any non-visualizer changes must be minimal, justified, and pruned aggressively.
- Keep the runtime browser-only. No API routes, no server-side query layer, no remote DB dependency.
- Keep using the repo's existing OpenAPI projection pipeline as the source of truth for schema shape.
- Use established libraries for graph/canvas/layout. Do not hand-roll the ERD canvas or layout engine.
- Preserve the existing SQL explorer as a secondary surface if helpful, but do not let it block or delay the ERD-first experience.

## Scope Guard

This phase is about the visualizer product experience and versioned artifact flow.

It is not a license to:

- refactor unrelated sync-engine logic
- revisit the full migration/parser/export architecture again unless a blocker is proven
- support every Stripe API version
- build a custom diagramming engine

## Phase 1: ERD First

## Goal

Add an `ERD` tab that, when selected, replaces the full main view with a canvas-based schema diagram.

## Required Outcome

- The visualizer opens into an ERD-first experience or makes the ERD tab the obvious primary destination.
- Clicking the `ERD` tab replaces the entire main workspace with a full-screen graph canvas.
- The ERD uses libraries for both graph interaction and layout. Prefer `@xyflow/react` plus `elkjs`, or an equivalent pair with the same maturity level.
- Tables are rendered as nodes.
- Node contents are derived from the actual loaded schema for the currently selected artifact, not from hardcoded table definitions.
- Each node shows:
  - table name
  - columns
  - only the first 10 columns by default
  - a bottom expand/collapse affordance to reveal or hide the remaining columns
- The canvas supports smooth pan/zoom and draggable nodes.
- The ERD remains aesthetically clean with many tables on screen.

## Important Constraint

The user primarily cares about visualizing tables and columns in the DB.

If relationship edges are reliably available from the loaded browser-safe metadata, render them.
If they are not reliably available from the hydrated PGlite schema, generate the smallest possible build-time schema sidecar needed for ERD relationships.
Do not reintroduce browser-breaking FK DDL into the bootstrap artifact just to force edges to exist in PGlite.
Do not parse `bootstrap.sql` in the browser.

## Acceptance Criteria

- ERD renders without hand-authored node coordinates.
- A schema with ~100 tables remains explorable.
- Expanding and collapsing nodes works per table and does not destroy layout usability.
- The existing explorer/table view still works if retained as a secondary tab.

## Phase 2: Version Picker

## Goal

After the ERD works on the current single artifact flow, add support for exactly 5 supported Stripe API versions using pre-generated static artifacts.

## Required Outcome

- The visualizer supports exactly 5 pinned API versions spanning years.
- Include `2020-08-27` as the baseline version.
- Choose the remaining 4 versions as resolvable Stripe API snapshots spread across later years.
- If a preferred candidate version does not resolve cleanly through the existing spec pipeline, replace it with the nearest resolvable yearly snapshot and document the final chosen list.
- Generate separate browser-loadable artifacts per version rather than trying to build them dynamically in-browser.
- Add a small index artifact that lists:
  - supported versions
  - default version
  - human-friendly labels
  - manifest/bootstrap paths
  - seed
  - table counts or similar lightweight metadata
- Add a shared version picker in the visualizer UI.
- Switching versions must fully switch the loaded artifact and reinitialize the active PGlite database for that version.
- Do not preload all 5 full SQL artifacts into memory at startup.

## Suggested Artifact Shape

Use a structure like:

```text
packages/visualizer/public/explorer-data/
  index.json
  <api-version-a>/manifest.json
  <api-version-a>/bootstrap.sql
  <api-version-b>/manifest.json
  <api-version-b>/bootstrap.sql
  ...
```

## Acceptance Criteria

- The ERD reflects the selected version's actual loaded schema.
- Version switching updates the loaded DB, not just the label in the UI.
- The current single-version build remains available for fast local iteration.
- Add one explicit multi-version build command for generating the 5-version matrix.

## Phase 3: 5x Data Volume

## Goal

Increase the fake data volume by about 5x while keeping the data believable and still shaped by the repo's OpenAPI projection logic.

## Required Outcome

- Increase total generated row volume by roughly 4x to 6x relative to the current baseline.
- Keep the existing graph-aware core entity generation logic.
- Preserve realistic Stripe-like relationships, timestamps, statuses, and reused parent entities.
- Do not satisfy this by naive duplication or random junk rows.
- Increase long-tail table volume too, but keep the artifacts usable in-browser.
- Tune counts if a literal 5x makes one or more versions unusable in the browser.

## Acceptance Criteria

- Core flows still look realistic:
  - `product -> price`
  - `customer -> payment_method`
  - `customer -> subscription -> subscription_items`
  - `subscription -> invoice`
  - `invoice -> payment_intent -> charge -> refund`
  - `customer -> checkout_session`
- All projected tables remain non-empty for supported versions unless the schema itself makes that impossible.
- The resulting artifacts still hydrate in-browser for each supported version.

## Change Containment Rules

- Prefer solving ERD and versioning inside the visualizer package.
- Only allow minimal changes outside it for:
  - multi-version artifact generation
  - schema metadata sidecar generation, if needed
  - seed volume tuning
  - top-level scripts/commands needed to run the new flow
- Avoid touching `packages/sync-engine/src/openapi/*` or other sync-engine internals unless a proven blocker makes it unavoidable.
- If a non-visualizer change is unavoidable, keep it isolated and explain why it was required.

## Verification

The harness should not declare success until all of the following are true.

### Phase 1 verification

- Run the existing single-version artifact build.
- Start the visualizer locally.
- Confirm the app opens into an ERD-first flow.
- Confirm the ERD canvas pans, zooms, and lays out tables automatically.
- Confirm at least several large tables render with 10 visible columns by default and expand/collapse correctly.

### Phase 2 verification

- Run the new multi-version build and confirm exactly 5 version directories plus an index artifact are produced.
- Start the visualizer and switch across all supported versions.
- Confirm the selected version changes the loaded schema metadata and visible table counts.
- Confirm switching versions rehydrates PGlite rather than reusing stale in-memory state.

### Phase 3 verification

- Rebuild at least one baseline version first with the increased data volume and confirm the UI remains usable.
- Then rebuild the full 5-version matrix.
- Confirm manifests reflect the denser dataset.
- Confirm the ERD and explorer still load for all supported versions.

## Done Means

This task is done when:

- `packages/visualizer` is an ERD-first schema browser
- the ERD is library-driven, clean, and based on the loaded schema
- exactly 5 supported API versions can be selected in-browser from pre-generated artifacts
- the data volume is meaningfully denser and still believable
- the solution remains browser-only and primarily isolated to the visualizer package

## Suggested Commands

The agent may add or update commands as needed, but the end state should support a workflow equivalent to:

```bash
pnpm explorer:build --api-version=2020-08-27
pnpm explorer:build:all
pnpm visualizer
```
