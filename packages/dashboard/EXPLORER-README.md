# Schema Explorer

This document describes the client-side Stripe schema explorer powered by PGlite (Postgres in the browser).

The explorer has two moving parts:
- A **build pipeline** that creates temporary Docker data and writes static artifacts.
- A browser runtime that loads those artifacts in PGlite.

### Generated artifacts

- `packages/dashboard/public/explorer-data/bootstrap.sql`
- `packages/dashboard/public/explorer-data/manifest.json`

`pnpm explorer:build` runs the full pipeline:
1. Start isolated Postgres harness.
2. Run migrations for all projected tables.
3. Seed deterministic fake data.
4. Export artifact files.
5. Stop and clean up harness.

### One command to run the build

```bash
pnpm explorer:build
```

If you want to regenerate artifacts and launch the dashboard in one step, run:

```bash
pnpm dashboard:with-data
```

Optional overrides:

```bash
pnpm explorer:build --api-version=2023-10-16
pnpm explorer:build --seed=1337
pnpm explorer:build --api-version=2023-10-16 --seed=1337
```

### How the dashboard loads data

At runtime, the app loads `manifest.json` first, then hydrates PGlite from `bootstrap.sql`.
After hydration, you can run SQL directly against the local schema in the browser.

```tsx
import { usePGlite } from '@/lib/pglite';

function ExplorerPanel() {
  const { status, error, query, manifest } = usePGlite();

  if (status === 'loading') return <p>Preparing explorer database…</p>;
  if (status === 'error') return <p>Unable to initialize explorer: {error}</p>;

  const loadCustomers = async () => {
    const result = await query('SELECT * FROM stripe.customers LIMIT 10');
    console.log(result.rows);
  };

  return (
    <>
      <p>Tables loaded: {manifest?.totalTables ?? 0}</p>
      <button onClick={loadCustomers}>Load customers</button>
    </>
  );
}
```

You can also execute non-select SQL with `exec()` and inspect `manifest.manifest` for row counts.

### Why the old phase scripts still exist

`pnpm explorer:build` is the normal command for development and CI.
The raw scripts still exist so you can debug each phase directly:

```bash
pnpm tsx scripts/explorer-harness.ts start
pnpm tsx scripts/explorer-migrate.ts -- --api-version=2020-08-27
pnpm tsx scripts/explorer-seed.ts -- --api-version=2020-08-27 --seed=42
pnpm tsx scripts/explorer-export.ts
```

### Notes

- `bootstrap.sql` and `manifest.json` are generated and should stay out of version control.
- SQL bootstrap is preferred for speed and consistency.
- The build scripts are expected to create, seed, and export from scratch each run.

### Harness details

`scripts/explorer-harness.ts` launches an isolated Postgres instance with:

- Random container and volume names
- Random port in the `50000-60000` range
- Strict safety checks to avoid colliding with shared instances
- Automatic cleanup (container + volume + metadata file) on stop

The generated metadata is stored in `.tmp/schema-explorer-run.json` and used by migrate/seed/export scripts.
