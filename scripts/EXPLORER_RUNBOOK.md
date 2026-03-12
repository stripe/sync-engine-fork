# Schema Explorer Runbook

This runbook explains how to generate artifacts, run the schema explorer locally, and deploy to Vercel.

## Table of Contents

1. [Overview](#overview)
2. [Generating an Artifact](#generating-an-artifact)
3. [Running Locally](#running-locally)
4. [Deploying to Vercel](#deploying-to-vercel)
5. [Troubleshooting](#troubleshooting)

---

## Overview

The Schema Explorer is a static web application that visualizes Stripe API schemas. It uses:

- **PGlite**: In-browser PostgreSQL powered by WebAssembly
- **Bootstrap SQL**: Pre-generated schema DDL + seed data
- **Manifest**: Metadata describing the artifact (API version, table counts, etc.)

The build pipeline generates these artifacts deterministically from a specific Stripe API version.

---

## Generating an Artifact

### Quick Start

Generate an artifact with default settings (API version `2020-08-27`, seed `42`):

```bash
pnpm explorer:build
```

### Custom API Version

Generate an artifact for a different Stripe API version:

```bash
pnpm explorer:build --api-version=2023-10-16
```

### Custom Seed

Generate an artifact with a different random seed (for reproducible data variations):

```bash
pnpm explorer:build --seed=1337
```

### Combined Options

```bash
pnpm explorer:build --api-version=2023-10-16 --seed=1337
```

### What Happens During Build?

The `explorer:build` script orchestrates these phases:

1. **Start Harness DB**: Creates an isolated Postgres container with a random suffix
2. **Run Migrations**: Applies all projected table migrations in `all_projected` mode
3. **Seed Data**: Generates deterministic fake Stripe data (customers, subscriptions, charges, etc.)
4. **Export Artifact**: Dumps the database to `bootstrap.sql` and generates `manifest.json`
5. **Stop Harness DB**: Cleans up the Docker container and volume

### Output Artifacts

After a successful build, you'll find:

```
packages/dashboard/public/explorer-data/
├── bootstrap.sql   # PGlite bootstrap SQL (schema DDL + INSERT statements)
└── manifest.json   # Metadata (API version, table counts, verification status)
```

### Build Time

Typical build time: **30-90 seconds** depending on:

- Number of projected tables in the API version
- Docker container startup time
- Host machine performance

---

## Running Locally

### Prerequisites

- Node.js 18+
- pnpm 10+
- Generated artifacts in `packages/dashboard/public/explorer-data/`

### Start the Dashboard

```bash
pnpm dashboard
```

This starts the Vite dev server on `http://localhost:5173` (or next available port).

### What You'll See

1. **Loading Screen**: PGlite initializes and loads `bootstrap.sql` into the in-browser database
2. **Schema Explorer**: Interactive UI showing:
   - Table list with row counts
   - Column definitions with types
   - Sample data rows
   - Manifest metadata (API version, seed, etc.)

### Development Workflow

When working on the explorer UI:

1. Run `pnpm dashboard` once to start the dev server
2. Edit files in `packages/dashboard/src/`
3. Vite will hot-reload changes automatically
4. Re-run `pnpm explorer:build` only if you need fresh data or a different API version

### Verifying the Artifact

Check the manifest to verify the artifact was generated correctly:

```bash
cat packages/dashboard/public/explorer-data/manifest.json | jq
```

Look for:

- `apiVersion`: Matches your target API version
- `totalTables`: Number of tables in the schema
- `verification.allTablesSeeded`: Should be `true` (all tables have data)
- `verification.emptyTables`: Should be `[]` (no empty tables)

---

## Deploying to Vercel

### Prerequisites

- Vercel account
- Vercel CLI installed (`npm i -g vercel`)
- Generated artifacts in `packages/dashboard/public/explorer-data/`

### Initial Setup

1. Navigate to the dashboard package:

   ```bash
   cd packages/dashboard
   ```

2. Link to Vercel (first time only):

   ```bash
   vercel link
   ```

   Follow the prompts to select or create a Vercel project.

3. Configure build settings in `vercel.json` (should already exist):

   ```json
   {
     "buildCommand": "pnpm build",
     "outputDirectory": "dist",
     "framework": "vite"
   }
   ```

### Deploy to Preview

Deploy to a preview URL (for testing):

```bash
vercel
```

This builds the dashboard and deploys to a temporary preview URL (e.g., `https://your-project-abc123.vercel.app`).

### Deploy to Production

Deploy to the production domain:

```bash
vercel --prod
```

### Deployment Checklist

Before deploying:

- [ ] Run `pnpm explorer:build` to generate fresh artifacts
- [ ] Verify artifacts exist in `packages/dashboard/public/explorer-data/`
- [ ] Check `manifest.json` for correct API version
- [ ] Test locally with `pnpm dashboard`
- [ ] Ensure artifact size is under budget (<10MB uncompressed)

### Automated Deployment (CI/CD)

To automate deployment on every commit:

1. Add Vercel GitHub integration to your repo
2. Configure build command in Vercel dashboard: `pnpm explorer:build && pnpm build`
3. Set environment variables (if needed): `STRIPE_API_VERSION=2023-10-16`

**Note**: The build pipeline requires Docker, so this works best with self-hosted CI runners that have Docker available. Vercel's build environment does NOT have Docker, so pre-generate artifacts and commit them to the repo if deploying via Vercel CI.

---

## Troubleshooting

### Pipeline Fails at "Start Harness DB"

**Symptoms**: Error starting Docker container

**Solutions**:

- Ensure Docker is installed and running: `docker ps`
- Check if port range 50000-60000 is available
- Verify no stale containers: `docker ps -a | grep schema-explorer`
- Manually clean up: `pnpm explorer:db:stop`

### Pipeline Fails at "Run Migrations"

**Symptoms**: Migration errors, missing tables

**Solutions**:

- Check if API version is valid: `--api-version=2020-08-27`
- Verify spec resolution works: check migration logs for OpenAPI spec download
- Ensure no database connection issues: check harness is running with `pnpm explorer:db:status`

### Pipeline Fails at "Seed Data"

**Symptoms**: Insert errors, constraint violations

**Solutions**:

- Check if tables were created in migration phase
- Verify seed value is a valid integer: `--seed=42`
- Review seed logs for specific table errors
- Some tables may fail due to missing FK relationships (expected for long-tail tables)

### Pipeline Fails at "Export Artifact"

**Symptoms**: Export errors, missing output files

**Solutions**:

- Ensure output directory exists: `packages/dashboard/public/explorer-data/`
- Check disk space (exports can be large)
- Verify database connection is still active

### Artifact Size Too Large

**Symptoms**: `bootstrap.sql` exceeds 10MB uncompressed

**Solutions**:

- Reduce seed row counts in `scripts/explorer-seed.ts`
- Filter out large long-tail tables
- Implement lazy hydration (load tables on-demand)

### Harness Won't Stop

**Symptoms**: `pnpm explorer:db:stop` fails or hangs

**Solutions**:

- List running containers: `docker ps | grep schema-explorer`
- Manually stop: `docker stop <container-id>`
- Remove container: `docker rm <container-id>`
- Remove volume: `docker volume rm <volume-name>`
- Delete metadata file: `rm .tmp/schema-explorer-run.json`

### Explorer Loads But Shows No Data

**Symptoms**: PGlite initializes but tables are empty

**Solutions**:

- Verify `bootstrap.sql` has INSERT statements (not just CREATE TABLE)
- Check browser console for SQL execution errors
- Ensure artifacts are in correct location: `packages/dashboard/public/explorer-data/`
- Verify manifest shows `verification.allTablesSeeded: true`

### Wrong API Version in Explorer

**Symptoms**: Manifest shows different API version than expected

**Solutions**:

- Re-run build with correct flag: `pnpm explorer:build --api-version=<version>`
- Check if artifacts were overwritten by another build
- Verify environment variable: `STRIPE_API_VERSION` is not set globally

---

## Advanced Usage

### Manual Phase Execution

Run individual phases for debugging:

```bash
# Start harness
pnpm explorer:db:start

# Check status
pnpm explorer:db:status

# Run migrations
pnpm explorer:migrate

# Seed data
pnpm explorer:seed

# Export artifact
pnpm explorer:export

# Stop harness
pnpm explorer:db:stop
```

### Custom Seed Counts

Edit row counts in `scripts/explorer-seed.ts` to control data volume:

```typescript
// Example: Reduce core table row counts
const count = 10 // was 25 for customers
```

Re-run:

```bash
pnpm explorer:build
```

### Inspecting the Harness Database

Connect to the running harness for debugging:

```bash
# Get connection details
pnpm explorer:db:status

# Connect with psql (example)
psql postgresql://explorer:explorer_pass_abc123@localhost:54321/schema_explorer

# Run queries
SELECT table_name, COUNT(*) FROM stripe.customers;
```

### Artifact Version Control

Commit generated artifacts to version control for deployment:

```bash
git add packages/dashboard/public/explorer-data/
git commit -m "Update explorer artifact to API version 2023-10-16"
git push
```

This enables deployment to Vercel CI (which doesn't have Docker) without rebuilding.

---

## Contact

For issues or questions, see the main project README or file an issue.
