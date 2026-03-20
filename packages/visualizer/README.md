# Stripe Schema Visualizer

This package contains the standalone browser UI for exploring generated Stripe schema data with PGlite.

The visualizer has two parts:

- `pnpm explorer:build` generates the full multi-version artifact set.
- `packages/visualizer` loads those artifacts into PGlite and renders the ERD in the browser.

## Generated artifacts

- `packages/visualizer/public/explorer-data/index.json`
- `packages/visualizer/public/explorer-data/<api-version>/bootstrap.sql`
- `packages/visualizer/public/explorer-data/<api-version>/manifest.json`
- `packages/visualizer/public/explorer-data/<api-version>/projection.json`

## Common commands

```bash
pnpm explorer:build
pnpm visualizer
pnpm visualizer:with-data
```

`pnpm visualizer:with-data` rebuilds all explorer artifacts and then starts the visualizer app.

## Vercel Deploy

For Vercel CLI deploys, point the project root at `packages/visualizer`.

```bash
cd /path/to/stripe-sync-engine-parallel-3
pnpm explorer:build
cd packages/visualizer
vercel
vercel --prod
```

Notes:
- The visualizer expects generated files under `public/explorer-data/`, including versioned `bootstrap.sql`, `manifest.json`, `projection.json`, plus `index.json`.
- Local CLI deploys can upload those generated files directly from your working tree.
- Git-based Vercel deploys will need those artifacts committed or generated during the remote build, because several of them are currently gitignored.

## How the app loads data

At runtime, the app loads `index.json`, resolves a concrete API version, and
hydrates PGlite from `/explorer-data/<api-version>/...` artifacts.
After hydration, the ERD can query the generated Stripe schema locally in the browser for fallback introspection.

Projection controls only reshape the ERD model. They do not rewrite the hydrated PGlite schema.

## Direct phase debugging

`pnpm explorer:build` is the normal command, but the underlying phase scripts still exist for debugging:

```bash
pnpm tsx scripts/explorer-harness.ts start
pnpm tsx scripts/explorer-migrate.ts --api-version=2020-08-27
pnpm tsx scripts/explorer-seed.ts --api-version=2020-08-27 --seed=42
pnpm tsx scripts/explorer-export.ts
pnpm tsx scripts/explorer-harness.ts stop
```

## Notes

- SQL bootstrap is preferred for speed and consistency.
- The build pipeline recreates the artifacts from scratch on each run.
- The deploy/install dashboard stays in `packages/dashboard`; this package only contains the schema visualizer UI.
