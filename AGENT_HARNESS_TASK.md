# Task: Full OpenAPI Sandbox + Client-Side Schema Explorer

## Mission
Build an isolated, reproducible local workflow and a minimal hosted explorer for this repo.

End state:
- A brand-new local Postgres Docker container is created and used for all migration + seeding work.
- The sync engine applies OpenAPI-derived DDL for all projected tables for the chosen API version, not only the current runtime-required subset.
- Deterministic fake data is generated for all projected tables.
- A versioned snapshot/artifact is exported for browser use.
- `packages/dashboard` becomes a very simple client-side schema explorer powered by React + `@electric-sql/pglite`, suitable for Vercel hosting.

## Non-Negotiable Constraints
- Always create and use a new local Postgres Docker container for this workflow.
- Never connect to or mutate the user's existing Postgres container.
- Never rely on ambient `.env` `DATABASE_URL` values for this task.
- Pass an explicit harness-owned local Docker `DATABASE_URL` into every DB step.
- Do not edit `.env` files for this workflow.
- Keep data generation deterministic from a fixed seed.
- Keep the current runtime sync path safe by default unless an explicit opt-in mode is added for explorer/all-tables behavior.
- Stop and ask if unexpected unrelated local changes appear in touched files.
- Be careful with `packages/sync-engine/package.json`, which already has local modifications.

## Important Repo Context
- The current runtime filter is in `packages/sync-engine/src/database/migrate.ts`:
  `allowedTables: [...RUNTIME_REQUIRED_TABLES]`
- The parser-level filtering behavior is in `packages/sync-engine/src/openapi/specParser.ts`.
- The browser-hostable app already exists at `packages/dashboard`.
- Use `packages/sync-engine/src/tests/testSetup.ts` as inspiration for isolated local Postgres lifecycle patterns.

## Phase 0: Preflight And Isolation Guardrails
### Goal
Create a safe harness-owned execution path before changing schema or data logic.

### Required outcomes
- Define one harness entrypoint or script that creates a fresh Docker Postgres container with:
  - unique container name
  - unique Docker volume
  - unique host port
  - explicit database name/user/password
- Persist the harness-owned connection details to a temp artifact the rest of the workflow can read.
- Add a hard safety check that refuses to run if:
  - host is not local
  - container id/name is not harness-owned
  - the DB URL matches a known shared/default local instance

### Notes
- Do not hardcode common names like `postgres`, `stripe-db`, `pg`, or port `5432`.
- Generate a random suffix for container/volume names.
- Prefer a temp workspace-local metadata file such as `.tmp/schema-explorer-run.json`.

### Acceptance
- One command can create a fresh isolated Postgres instance and print/write its connection details.
- Re-running does not reuse the user's existing DB container.
- Cleanup only removes harness-created Docker resources.

## Phase 1: Full OpenAPI Projection Into Postgres
### Goal
Get a database with all projected OpenAPI tables, not just the runtime-required subset.

### Required outcomes
- Start by changing the OpenAPI migration path so explorer mode can materialize all projected tables.
- Preferred implementation:
  - add an explicit table-mode/config option such as:
    - `runtime_required` (current behavior, default)
    - `all_projected` (new explorer behavior)
- In `all_projected` mode, do not pass `allowedTables`.
- Keep existing default runtime behavior unchanged unless there is a very strong reason not to.

### Mandatory checkpoint
- After removing the `allowedTables` filter, compare:
  - number of parsed/projected tables
  - number of actual Postgres tables created
- If the count is still close to the current subset, the remaining limitation is likely parser scope, not migration filtering.
- In that case:
  - document the finding clearly
  - determine whether "all tables" for this exercise should mean:
    - all currently projectable resource-backed tables, or
    - a broader parser expansion
- Prefer shipping the explorer against all currently projectable tables first rather than getting stuck on a giant parser rewrite.

### Required verification
- Add or update tests proving:
  - runtime/default migration behavior still works
  - explorer/all-projected mode creates the full expected set for a pinned API version
- Produce a table inventory artifact for the chosen API version.

### Acceptance
- Fresh harness DB can be migrated in `all_projected` mode.
- A machine-readable inventory exists with zero missing expected tables.
- Existing default behavior is preserved or intentionally documented if changed.

## Phase 2: Deterministic Fake Data For All Projected Tables
### Goal
Populate every projected table with deterministic synthetic data.

### Requirements
- Use a fixed seed and deterministic id/timestamp generation.
- Use `faker` or similar for realistic-looking values.
- Seed via valid `_raw_data` payloads so generated columns work naturally.
- Insert an `accounts` row first so FK constraints are satisfied.
- Every projected table should be non-empty unless there is a concrete technical reason it cannot be seeded.
- If any table is intentionally excluded, emit that exclusion explicitly in the manifest/logs.

### Seeding strategy
- Use a two-layer seeding model:
  - graph-aware generators for core Stripe flows
  - generic schema-aware fallback generator for long-tail tables

### Core graph-aware generators
Implement realistic-enough relationships for at least:
- `products`
- `prices`
- `customers`
- `payment_methods`
- `subscriptions`
- `subscription_items`
- `invoices`
- `payment_intents`
- `charges`
- `refunds`
- `checkout_sessions`
- `credit_notes`
- `disputes`
- `setup_intents`
- `tax_ids`

### Generic fallback generator
- For remaining projected tables, generate type-correct `_raw_data` using:
  - projected column metadata
  - OpenAPI schema info where useful
  - stable ID prefixes
  - stable timestamp windows
- Fallback rows do not need perfect business realism.
- They do need to be queryable, internally type-consistent, and useful in the explorer.

### Output expectations
- Produce row counts per table.
- Keep dataset size reasonable for browser loading.
- Suggested starting target:
  - dense core tables: dozens to low hundreds
  - long-tail tables: 1-20 rows

### Acceptance
- Every projected table returns `count(*) >= 1`, unless explicitly justified and listed.
- Re-running with the same seed produces materially identical results.
- FK relationships and common joins work for core billing/payment flows.

## Phase 3: Versioned Snapshot / Artifact Export
### Goal
Turn the seeded Docker/Postgres database into a frontend-loadable artifact.

### Requirements
- The browser app must not talk to the Docker DB at runtime.
- Export a versioned artifact keyed by at least:
  - `apiVersion`
  - spec fingerprint/hash
  - seed
- Include a manifest with:
  - api version
  - spec fingerprint
  - generated-at timestamp
  - table list
  - row counts
  - any excluded tables

### Implementation guidance
- Choose the simplest reliable browser-load path.
- Acceptable options:
  - PGlite data-dir/tarball snapshot
  - SQL bootstrap artifact
  - compact per-table JSON + bootstrap loader into PGlite
- Prefer reliability and debuggability over theoretical elegance.
- If direct PGlite snapshot creation is awkward, use a manifest + SQL/JSON hydration path.

### Multi-version support
- Design the artifact format so multiple API versions can coexist later.
- It is acceptable to ship one default API version first.
- The architecture must make it obvious how to add another version without redesigning everything.

### Acceptance
- There is at least one stable generated artifact that can fully hydrate the explorer without Docker.
- The manifest accurately matches the seeded DB.

## Phase 4: Minimal Client-Side Explorer In `packages/dashboard`
### Goal
Create a super simple, clean, white-mode schema explorer UI that runs entirely client-side at runtime.

### Product requirements
- Use React in `packages/dashboard`.
- Keep runtime fully client-side for data access and SQL execution.
- Use `@electric-sql/pglite`.
- Use a simple modern SQL editor such as CodeMirror.
- Minimalist white-mode UI.
- Layout:
  - left pane: tables list
  - right pane: split vertically
  - top-right: SQL editor
  - bottom-right: result table/grid
- Clicking a table should run a default `SELECT * FROM "<table>" LIMIT ...` query.
- Show the selected table name and row count if available.

### Implementation guidance
- Prefer adding a dedicated explorer route in `packages/dashboard` rather than deleting unrelated dashboard behavior immediately.
- Do not depend on existing `app/api/*` routes for explorer runtime behavior.
- Keep styling simple and native-looking.
- No auth.
- No mutations.
- No saved queries.
- No heavy design system unless already present and truly necessary.

### Minimum UX bar
- Fast startup.
- Clear loading and error states.
- Query results render in a readable scrollable table.
- Table click changes both selection and displayed query/results.

### Acceptance
- `packages/dashboard` can load the generated artifact fully client-side.
- The left pane shows all tables from the manifest.
- Clicking any table runs the default query and displays rows.
- Manual SQL queries run in the editor and display results below.
- The app can be deployed to Vercel without needing a live backend database.

## Phase 5: Verification And End-To-End Workflow
### Goal
Prove the full local-to-browser pipeline works.

### Required verification
- Add an end-to-end happy-path run that:
  - creates fresh Docker Postgres
  - applies full projected DDL
  - seeds data
  - exports artifact
  - loads explorer
- Verify:
  - full projected table inventory exists
  - every expected table has data
  - artifact can hydrate the browser DB
  - clicking a table runs the default query successfully

### Suggested automated checks
- test for table inventory vs manifest
- test for deterministic seeding with fixed seed
- test that artifact hydration exposes all expected tables
- light UI smoke test for table click -> query -> render

### Acceptance
- One repeatable local workflow goes from empty state to working explorer data.
- Failures are phase-specific and easy to diagnose.

## Suggested Deliverables
- Docker harness helper(s) for isolated local Postgres lifecycle.
- Explorer/all-projected OpenAPI migration mode.
- Deterministic fake-data generator.
- Versioned artifact exporter + manifest.
- Minimal explorer route/page in `packages/dashboard`.
- Short runbook explaining:
  - how to generate artifact for a given API version
  - how to run the explorer locally
  - how to deploy to Vercel

## Suggested Script Shape
Exact names are flexible, but the workflow should feel roughly like this:

```sh
pnpm explorer:db:start
pnpm explorer:artifact --api-version 2020-08-27 --seed 42
pnpm --filter @supabase/stripe-sync-dashboard dev
```

Or one higher-level orchestration command:

```sh
pnpm explorer:build --api-version 2020-08-27 --seed 42
```

## Explicit Guardrails For The Agent
- Do not use the user's existing Docker Postgres container.
- Do not use `.env` `DATABASE_URL`.
- Do not point the browser app at a live DB.
- Do not silently keep runtime-only table filtering in the explorer path.
- Do not block indefinitely on parser perfection if removing the filter already exposes all currently projectable tables.
- Do not rewrite the whole dashboard into a complex product. Keep it intentionally small.
- Stop and ask if the dirty `packages/sync-engine/package.json` must be modified in a way that could conflict with the user's local changes.

## Final Success Criteria
- New isolated Docker Postgres container created and used for all DB work.
- Full projected OpenAPI schema materialized for explorer mode.
- Deterministic fake data present across all projected tables.
- Versioned artifact generated for browser hydration.
- Minimal white-mode client-side schema explorer working in `packages/dashboard`.
