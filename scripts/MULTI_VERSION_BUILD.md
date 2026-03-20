# Multi-Version Schema Explorer Build

## Overview

The multi-version build system generates schema explorer artifacts for 5 pinned Stripe API versions, creating a versioned subdirectory for each version under `packages/visualizer/public/explorer-data/`.

## Usage

Build all versions:
```bash
pnpm explorer:build
```

Build with custom seed:
```bash
pnpm explorer:build --seed=1337
```

## Pinned API Versions

The following 5 versions are hardcoded in `scripts/explorer-build-all.ts`:

| Version    | Purpose              | Description                                      | Est. Tables |
|------------|----------------------|--------------------------------------------------|-------------|
| 2020-08-27 | Baseline (Required)  | Earliest stable API, foundational schema         | ~106        |
| 2022-08-01 | Mid-2022 Snapshot    | 2-year evolution, post-pandemic expansions       | ~108        |
| 2023-08-16 | Mid-2023 Snapshot    | Connect and Treasury expansions                  | ~112        |
| 2024-06-20 | Mid-2024 Snapshot    | Recent API maturity improvements                 | ~120        |
| 2025-01-27 | Latest Snapshot      | Current state, labeled "Latest" in UI            | ~125        |

These versions span ~4.5 years of Stripe API evolution with roughly yearly intervals.

## Version Selection Rationale

1. **2020-08-27** - Mandated baseline version, earliest stable snapshot
2. **2022-08-01** - Mid-point snapshot showing ~2 years of evolution
3. **2023-08-16** - Captures Connect/Treasury product expansions
4. **2024-06-20** - Recent maturity improvements and API refinements
5. **2025-01-27** - Latest available snapshot for current schema state

## Output Structure

After running `pnpm explorer:build`, the output structure is:

```
packages/visualizer/public/explorer-data/
├── 2020-08-27/
│   ├── bootstrap.sql       # PGlite-compatible schema + data
│   └── manifest.json       # Table counts, seed info, metadata
├── 2022-08-01/
│   ├── bootstrap.sql
│   └── manifest.json
├── 2023-08-16/
│   ├── bootstrap.sql
│   └── manifest.json
├── 2024-06-20/
│   ├── bootstrap.sql
│   └── manifest.json
├── 2025-01-27/
│   ├── bootstrap.sql
│   └── manifest.json
├── index.json              # Version registry with metadata
├── bootstrap.sql           # Flat default-version compatibility alias
└── manifest.json           # Flat default-version compatibility alias
```

## Index.json Schema

The `index.json` file lists all available versions:

```json
{
  "defaultVersion": "2020-08-27",
  "versions": [
    {
      "apiVersion": "2020-08-27",
      "label": "2020-08-27",
      "manifestPath": "/explorer-data/2020-08-27/manifest.json",
      "bootstrapPath": "/explorer-data/2020-08-27/bootstrap.sql",
      "tableCount": 106,
      "totalRows": 2000
    },
    // ... additional versions
  ]
}
```

## Build Pipeline

For each version, the script:

1. **Start harness DB** - Spins up isolated Postgres container
2. **Run migrations** - Applies projected schema for the API version
3. **Seed data** - Generates deterministic fake Stripe data
4. **Export artifact** - Dumps PGlite-compatible SQL + metadata
5. **Stop harness DB** - Cleans up container

After all versions complete, it generates `index.json` with metadata for each version
and copies the default version to the flat artifact paths used during initial app bootstrap.

## Updating Versions

To change the pinned versions, edit the `PINNED_VERSIONS` constant in `scripts/explorer-build-all.ts`:

```typescript
const PINNED_VERSIONS = [
  '2020-08-27', // Baseline version (required)
  '2022-08-01', // Mid-2022 snapshot
  '2023-08-16', // Mid-2023 snapshot
  '2024-06-20', // Mid-2024 snapshot
  '2025-01-27', // Latest snapshot (early 2025)
] as const
```

**Important:** Ensure replacement versions resolve cleanly through the spec pipeline before committing changes.

## Troubleshooting

### Version fails to build

If a specific version fails during migration or seeding, try:

1. Verify the version exists in the OpenAPI spec repository
2. Check for breaking schema changes in that version
3. Substitute with the nearest resolvable version from the same year
4. Update `PINNED_VERSIONS` constant with the working version

### Out of disk space

Each version generates ~5-10MB of artifacts. With 5 versions:
- Total disk usage: ~25-50MB uncompressed
- Ensure sufficient space in `packages/visualizer/public/explorer-data/`

### Build takes too long

Typical build times per version:
- Harness start: ~5-10s
- Migrations: ~5-15s
- Seeding: ~10-30s (depends on table count)
- Export: ~5-10s
- Total per version: ~30-60s
- **Total for 5 versions: ~3-5 minutes**

To speed up development:
- Use cached Docker images (harness reuses existing Postgres image)
- Keep `pnpm visualizer` running separately and rerun `pnpm explorer:build` only when artifacts need refresh

## Testing

Verify the build output:

```bash
# Build all versions
pnpm explorer:build

# Check output structure
ls -la packages/visualizer/public/explorer-data/

# Verify index.json was generated
cat packages/visualizer/public/explorer-data/index.json

# Start visualizer to test in browser
pnpm visualizer
```

## Related Scripts

- `scripts/explorer-harness.ts` - Postgres container management
- `scripts/explorer-migrate.ts` - Schema migration runner
- `scripts/explorer-seed.ts` - Deterministic data seeder
- `scripts/explorer-export.ts` - SQL + metadata exporter

## Acceptance Criteria

✅ Running `pnpm explorer:build` produces exactly 5 versioned subdirectories
✅ Each subdirectory contains a valid `bootstrap.sql` and `manifest.json`
✅ An `index.json` is generated listing all 5 versions
✅ 2020-08-27 is included as the baseline version
✅ The remaining 4 versions span later years and resolve successfully
✅ The final list of chosen versions is documented in this file and in the script
