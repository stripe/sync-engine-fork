#!/usr/bin/env tsx
/**
 * Multi-Version Schema Explorer Build Orchestration Script
 *
 * This script builds schema explorer artifacts for exactly 6 pinned API versions,
 * creating a versioned subdirectory for each version with bootstrap.sql and manifest.json.
 * After all versions are built, it generates an index.json file listing all versions with metadata.
 *
 * Pinned API Versions (6 total):
 * - 2020-08-27 (baseline version - earliest stable API)
 * - 2022-08-01 (mid-2022 snapshot)
 * - 2023-08-16 (mid-2023 snapshot)
 * - 2024-06-20 (mid-2024 snapshot)
 * - 2025-01-27 (latest v1 snapshot - early 2025)
 * - 2026-02-24 (latest v2 snapshot - unified v1+v2, >= 2026-01-28 cutoff)
 *
 * These versions span ~5.5 years of Stripe API evolution and were selected to:
 * 1. Include 2020-08-27 as the baseline (requirement)
 * 2. Spread across years with ~1-year intervals
 * 3. Resolve cleanly through the existing spec pipeline
 * 4. Capture major schema evolution milestones including v2 unification
 *
 * Usage:
 *   pnpm explorer:build [--seed=42]
 *   pnpm explorer:build:all [--seed=42]
 *
 * Flags:
 *   --seed  Random seed for deterministic data generation (default: 42)
 *
 * Output:
 *   packages/visualizer/public/explorer-data/
 *     ├── 2020-08-27/
 *     │   ├── bootstrap.sql
 *     │   ├── manifest.json
 *     │   └── projection.json
 *     ├── 2022-08-01/
 *     │   ├── bootstrap.sql
 *     │   ├── manifest.json
 *     │   └── projection.json
 *     ├── 2023-08-16/
 *     │   ├── bootstrap.sql
 *     │   ├── manifest.json
 *     │   └── projection.json
 *     ├── 2024-06-20/
 *     │   ├── bootstrap.sql
 *     │   ├── manifest.json
 *     │   └── projection.json
 *     ├── 2025-01-27/
 *     │   ├── bootstrap.sql
 *     │   ├── manifest.json
 *     │   └── projection.json
 *     ├── 2026-02-24/
 *     │   ├── bootstrap.sql
 *     │   ├── manifest.json
 *     │   └── projection.json
 *     ├── index.json
 *     ├── bootstrap.sql
 *     └── manifest.json
 */

import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const EXPLORER_DATA_DIR = path.join(
  process.cwd(),
  'packages/visualizer/public/explorer-data'
)
const TMP_DIR = path.join(process.cwd(), '.tmp')
const METADATA_FILE = path.join(TMP_DIR, 'schema-explorer-run.json')

/**
 * Pinned API versions to build
 *
 * These versions are hardcoded to ensure consistent, reproducible multi-version artifacts.
 *
 * VERSION SELECTION RATIONALE:
 *
 * 1. 2020-08-27 (Baseline - Required)
 *    - Earliest stable API version mandated by requirements
 *    - Serves as the foundational schema snapshot
 *    - ~106 tables expected
 *
 * 2. 2022-08-01 (Mid-2022 Snapshot)
 *    - ~2-year evolution from baseline
 *    - Captures post-pandemic API expansions
 *    - Represents mid-point in version timeline
 *
 * 3. 2023-08-16 (Mid-2023 Snapshot)
 *    - ~1-year evolution from 2022 snapshot
 *    - Captures Connect and Treasury expansions
 *    - ~112 tables expected
 *
 * 4. 2024-06-20 (Mid-2024 Snapshot)
 *    - ~1-year evolution from 2023 snapshot
 *    - Captures recent API maturity improvements
 *    - ~120 tables expected
 *
 * 5. 2025-01-27 (Latest v1 Snapshot)
 *    - Most recent v1-only API version available
 *    - Represents mature v1 schema state
 *    - Last version before unified v2 artifacts
 *
 * 6. 2026-02-24 (Latest v2)
 *    - First v2-capable API version (>= 2026-01-28 unified v2 cutoff)
 *    - Includes merged /v2 endpoints and v2.* schemas
 *    - Enables v2 projection mode demonstrations
 *    - Represents unified v1+v2 schema state
 *
 * These 6 versions provide roughly yearly snapshots across 5+ years of API evolution,
 * enabling users to visualize schema changes, table additions, relationship patterns,
 * and the v1-to-v2 migration across major Stripe product releases.
 *
 * Note: If any of these versions fail to resolve through the spec pipeline, substitute
 * with the nearest resolvable version (preferring later dates within the same year).
 */
const PINNED_VERSIONS = [
  '2020-08-27', // Baseline version (required)
  '2022-08-01', // Mid-2022 snapshot
  '2023-08-16', // Mid-2023 snapshot
  '2024-06-20', // Mid-2024 snapshot
  '2025-01-27', // Latest v1 snapshot (early 2025)
  '2026-02-24', // Latest v2 snapshot (unified v1+v2, >= 2026-01-28 cutoff)
] as const

interface BuildConfig {
  seed: number
}

interface VersionMetadata {
  apiVersion: string
  label: string
  manifestPath: string
  bootstrapPath: string
  projectionPath: string
  tableCount: number
  totalRows: number
}

interface IndexData {
  defaultVersion: string
  versions: VersionMetadata[]
}

interface ManifestData {
  timestamp: string
  seed: number
  apiVersion: string
  totalTables: number
  coreTables: string[]
  longTailTables: string[]
  manifest: Record<string, number>
  failedTables: string[]
  verification: {
    allTablesSeeded: boolean
    tablesWithData: number
    emptyTables: string[]
  }
}

/**
 * Parse command line arguments
 */
function parseArgs(): BuildConfig {
  const args = process.argv.slice(2)
  const config: BuildConfig = {
    seed: 42,
  }

  for (const arg of args) {
    if (arg.startsWith('--seed=')) {
      config.seed = parseInt(arg.split('=')[1], 10)
      if (isNaN(config.seed)) {
        throw new Error(`Invalid seed value: ${arg.split('=')[1]}`)
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: pnpm explorer:build [--seed=42]')
      console.log('')
      console.log('Flags:')
      console.log('  --seed  Random seed for deterministic data generation (default: 42)')
      console.log('')
      console.log('Pinned API Versions:')
      PINNED_VERSIONS.forEach((version) => console.log(`  - ${version}`))
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return config
}

/**
 * Execute a command and handle errors with context
 */
function execPhase(command: string, phase: string, env?: NodeJS.ProcessEnv): void {
  try {
    execSync(command, {
      stdio: 'inherit',
      env: env ? { ...process.env, ...env } : process.env,
    })
  } catch (error) {
    console.error(`\n❌ Build failed at phase: ${phase}`)
    console.error(`   Command: ${command}`)
    throw error
  }
}

function isHarnessRunning(): boolean {
  return fs.existsSync(METADATA_FILE)
}

/**
 * Build artifacts for a single API version
 */
async function buildVersionArtifacts(
  apiVersion: string,
  seed: number
): Promise<void> {
  console.log(`\n${'='.repeat(79)}`)
  console.log(`📦 Building version: ${apiVersion}`)
  console.log(`${'='.repeat(79)}\n`)

  const outputDir = path.join(EXPLORER_DATA_DIR, apiVersion)
  let shouldCleanup = false

  try {
    console.log('📦 Phase 1: Starting harness database...\n')

    if (isHarnessRunning()) {
      console.log('⚠️  Harness already running. Stopping existing instance first...\n')
      try {
        execPhase('pnpm tsx scripts/explorer-harness.ts stop', 'Pre-cleanup')
      } catch {
        if (fs.existsSync(METADATA_FILE)) {
          fs.unlinkSync(METADATA_FILE)
        }
      }
      console.log('')
    }

    execPhase('pnpm tsx scripts/explorer-harness.ts start', `Start Harness DB (${apiVersion})`)
    shouldCleanup = true

    console.log('\n✅ Phase 1 complete\n')
    console.log('═══════════════════════════════════════════════════════════\n')
    console.log('📦 Phase 2: Running migrations (all_projected mode)...\n')

    execPhase(
      `pnpm tsx scripts/explorer-migrate.ts --api-version=${apiVersion}`,
      `Migrate schema (${apiVersion})`,
      {
        STRIPE_API_VERSION: apiVersion,
      }
    )

    console.log('\n✅ Phase 2 complete\n')
    console.log('═══════════════════════════════════════════════════════════\n')
    console.log('📦 Phase 3: Seeding deterministic data...\n')

    execPhase(
      `pnpm tsx scripts/explorer-seed.ts --api-version=${apiVersion} --seed=${seed}`,
      `Seed data (${apiVersion})`,
      {
        STRIPE_API_VERSION: apiVersion,
        SEED: String(seed),
      }
    )

    console.log('\n✅ Phase 3 complete\n')
    console.log('═══════════════════════════════════════════════════════════\n')
    console.log('📦 Phase 4: Exporting artifact...\n')

    execPhase(
      `pnpm tsx scripts/explorer-export.ts --output-dir=${outputDir}`,
      `Export artifact (${apiVersion})`
    )

    console.log('\n✅ Phase 4 complete\n')
    console.log('═══════════════════════════════════════════════════════════\n')
    console.log('📦 Phase 5: Generating projection metadata...\n')

    execPhase(
      `pnpm tsx packages/visualizer/build/generate-projection.ts --api-version=${apiVersion} --output-dir=${outputDir}`,
      `Generate projection (${apiVersion})`
    )

    console.log('\n✅ Phase 5 complete\n')
    console.log('═══════════════════════════════════════════════════════════\n')
    console.log('📦 Phase 6: Cleaning up harness database...\n')

    execPhase('pnpm tsx scripts/explorer-harness.ts stop', `Stop Harness DB (${apiVersion})`)
    shouldCleanup = false

    console.log('\n✅ Phase 6 complete\n')
  } catch (error) {
    if (shouldCleanup && isHarnessRunning()) {
      console.error('\n🧹 Attempting to clean up harness database...\n')
      try {
        execSync('pnpm tsx scripts/explorer-harness.ts stop', { stdio: 'inherit' })
        console.error('\n✅ Cleanup successful\n')
      } catch {
        console.error('\n⚠️  Cleanup failed. You may need to manually stop the container:\n')
        console.error('   pnpm tsx scripts/explorer-harness.ts stop\n')
      }
    }
    throw error
  }

  console.log(`\n✅ Version ${apiVersion} build complete\n`)
}

/**
 * Read manifest.json for a version and extract metadata
 */
function readVersionMetadata(apiVersion: string): VersionMetadata {
  const manifestPath = path.join(EXPLORER_DATA_DIR, apiVersion, 'manifest.json')

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found for version ${apiVersion}: ${manifestPath}`)
  }

  const manifest: ManifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))

  // Calculate total rows across all tables
  const totalRows = Object.values(manifest.manifest).reduce((sum, count) => sum + count, 0)

  // Determine label (mark latest v2 version)
  const isLatestV2 = apiVersion === PINNED_VERSIONS[PINNED_VERSIONS.length - 1]
  const label = isLatestV2 ? `${apiVersion} (Latest v2)` : apiVersion

  return {
    apiVersion,
    label,
    manifestPath: `/explorer-data/${apiVersion}/manifest.json`,
    bootstrapPath: `/explorer-data/${apiVersion}/bootstrap.sql`,
    projectionPath: `/explorer-data/${apiVersion}/projection.json`,
    tableCount: manifest.totalTables,
    totalRows,
  }
}

/**
 * Generate index.json file listing all versions
 */
function generateIndex(versionMetadata: VersionMetadata[]): void {
  console.log('\n📊 Generating index.json...\n')

  const indexData: IndexData = {
    defaultVersion: PINNED_VERSIONS[PINNED_VERSIONS.length - 1], // Default to latest available version
    versions: versionMetadata,
  }

  const indexPath = path.join(EXPLORER_DATA_DIR, 'index.json')
  fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2))

  console.log(`   ✓ Written to ${indexPath}`)
  console.log(`   ✓ Default version: ${indexData.defaultVersion}`)
  console.log(`   ✓ Total versions: ${versionMetadata.length}`)

  // Print summary table
  console.log('\n📋 Version Summary:')
  console.log('')
  console.log('  Version       | Tables | Total Rows | Label')
  console.log('  --------------|--------|------------|---------------------------')
  versionMetadata.forEach((v) => {
    const versionPad = v.apiVersion.padEnd(13)
    const tablesPad = String(v.tableCount).padStart(6)
    const rowsPad = String(v.totalRows).padStart(10)
    console.log(`  ${versionPad} | ${tablesPad} | ${rowsPad} | ${v.label}`)
  })
  console.log('')
}

function writeLegacyDefaultArtifacts(defaultVersion: string): void {
  const versionDir = path.join(EXPLORER_DATA_DIR, defaultVersion)
  const versionManifest = path.join(versionDir, 'manifest.json')
  const versionBootstrap = path.join(versionDir, 'bootstrap.sql')
  const legacyManifest = path.join(EXPLORER_DATA_DIR, 'manifest.json')
  const legacyBootstrap = path.join(EXPLORER_DATA_DIR, 'bootstrap.sql')

  if (!fs.existsSync(versionManifest) || !fs.existsSync(versionBootstrap)) {
    throw new Error(`Default version artifacts missing for ${defaultVersion}`)
  }

  fs.copyFileSync(versionManifest, legacyManifest)
  fs.copyFileSync(versionBootstrap, legacyBootstrap)

  console.log('\n📎 Writing legacy default artifacts...\n')
  console.log(`   ✓ ${defaultVersion}/manifest.json -> manifest.json`)
  console.log(`   ✓ ${defaultVersion}/bootstrap.sql -> bootstrap.sql`)
}

/**
 * Main orchestration function
 */
async function main(): Promise<void> {
  console.log('🚀 Multi-Version Schema Explorer Build Pipeline\n')
  console.log('═'.repeat(79))

  // Parse configuration
  let config: BuildConfig
  try {
    config = parseArgs()
  } catch (error) {
    console.error('❌ Configuration error:', (error as Error).message)
    process.exit(1)
  }

  console.log('\n📋 Configuration:')
  console.log(`   Seed: ${config.seed}`)
  console.log(`   Versions: ${PINNED_VERSIONS.length}`)
  console.log('')
  console.log('   Pinned API Versions:')
  PINNED_VERSIONS.forEach((version, index) => {
    const label = index === 0 ? ' (baseline)' : index === PINNED_VERSIONS.length - 1 ? ' (latest)' : ''
    console.log(`   ${index + 1}. ${version}${label}`)
  })
  console.log('')
  console.log(`   Output Directory: ${EXPLORER_DATA_DIR}`)
  console.log('\n' + '═'.repeat(79))

  const startTime = Date.now()
  const versionMetadata: VersionMetadata[] = []

  try {
    // Build artifacts for each version
    for (let i = 0; i < PINNED_VERSIONS.length; i++) {
      const apiVersion = PINNED_VERSIONS[i]
      const progress = `[${i + 1}/${PINNED_VERSIONS.length}]`

      console.log(`\n${progress} Processing version: ${apiVersion}`)
      await buildVersionArtifacts(apiVersion, config.seed)

      // Read metadata from generated manifest
      const metadata = readVersionMetadata(apiVersion)
      versionMetadata.push(metadata)

      console.log(`${progress} ✅ Version ${apiVersion} complete`)
      console.log(`          Tables: ${metadata.tableCount}, Rows: ${metadata.totalRows}`)
    }

    // Generate index.json and flat default artifacts for the current app bootstrap path.
    console.log('\n' + '═'.repeat(79))
    generateIndex(versionMetadata)
    writeLegacyDefaultArtifacts(PINNED_VERSIONS[0])

    // Success summary
    const duration = Math.round((Date.now() - startTime) / 1000)
    console.log('\n' + '═'.repeat(79))
    console.log('🎉 Multi-version build complete!\n')
    console.log(`   Duration: ${duration}s`)
    console.log(`   Versions built: ${PINNED_VERSIONS.length}`)
    console.log(`   Total tables: ${versionMetadata.reduce((sum, v) => sum + v.tableCount, 0)}`)
    console.log(`   Total rows: ${versionMetadata.reduce((sum, v) => sum + v.totalRows, 0)}`)
    console.log('')
    console.log('📦 Artifacts generated:')
    versionMetadata.forEach((v) => {
      console.log(`   - ${v.apiVersion}/`)
      console.log(`     ├── bootstrap.sql`)
      console.log(`     ├── manifest.json`)
      console.log(`     └── projection.json`)
    })
    console.log(`   - index.json`)
    console.log(`   - manifest.json (legacy default alias)`)
    console.log(`   - bootstrap.sql (legacy default alias)`)
    console.log('')
    console.log('💡 Next steps:')
    console.log('   - Run locally: pnpm visualizer')
    console.log('   - Deploy to Vercel: see scripts/EXPLORER_RUNBOOK.md')
    console.log('')
  } catch (error) {
    const duration = Math.round((Date.now() - startTime) / 1000)
    console.error('\n' + '═'.repeat(79))
    console.error('❌ Multi-version build failed\n')
    console.error(`   Duration: ${duration}s`)
    console.error(`   Error: ${(error as Error).message || error}`)
    console.error('')
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error.message || error)
  process.exit(1)
})
