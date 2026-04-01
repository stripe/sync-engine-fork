#!/usr/bin/env node
/**
 * Fetches every published Stripe REST API spec version from github.com/stripe/openapi
 * and writes <version>.json + manifest.json to <outputDir>.
 *
 * Usage:
 *   node generate-stripe-specs.mjs <outputDir>
 *
 * Uses a blobless git clone — no GitHub API rate limits, no auth required.
 * Set STRIPE_OPENAPI_REPO to a pre-cloned path to skip the clone (e.g. from CI cache).
 *
 * These are the official Stripe REST API specs (github.com/stripe/openapi), NOT
 * the Sync Engine's own OpenAPI spec (which lives at /openapi/engine.json etc.).
 *
 * No npm dependencies.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const [outputDir] = process.argv.slice(2)
if (!outputDir) {
  console.error('Usage: node generate-stripe-specs.mjs <outputDir>')
  process.exit(1)
}

const REPO_URL = 'https://github.com/stripe/openapi'
// stripe/openapi uses 'latest/openapi.spec3.sdk.json' for recent specs and
// 'openapi/spec3.json' for historic ones.
const SPEC_PATHS = ['latest/openapi.spec3.sdk.json', 'openapi/spec3.json']

function git(...args) {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' })
}

// Clone or use pre-cloned repo (STRIPE_OPENAPI_REPO lets CI inject a cached clone)
const repoDir = process.env.STRIPE_OPENAPI_REPO ?? join(tmpdir(), 'stripe-openapi')
if (!existsSync(join(repoDir, '.git'))) {
  console.error(`Cloning ${REPO_URL} (blobless)...`)
  execFileSync(
    'git',
    ['clone', '--filter=blob:none', '--no-tags', '--single-branch', REPO_URL, repoDir],
    { stdio: 'inherit' }
  )
} else {
  console.error(`Using pre-cloned repo at ${repoDir}`)
}

// Find all commits that touched either spec path.
// ls-tree reads tree objects (included in blobless clone) — no network needed here.
console.error('Finding relevant commits...')
const commits = git('log', '--format=%H', '--', ...SPEC_PATHS).trim().split('\n').filter(Boolean)
console.error(`  ${commits.length} commits`)

// Collect unique blob SHAs via ls-tree (local, no network) to avoid re-fetching duplicates.
// Two commits that share a blob SHA have identical content → only fetch once.
const blobToPath = new Map() // blobSha -> specPath
for (const commit of commits) {
  for (const specPath of SPEC_PATHS) {
    let ls
    try {
      ls = git('ls-tree', commit, specPath).trim()
    } catch {
      continue
    }
    if (!ls) continue
    const blobSha = ls.split(/\s+/)[2]
    if (!blobToPath.has(blobSha)) {
      blobToPath.set(blobSha, specPath)
    }
    break // one spec per commit is enough
  }
}
console.error(`  ${blobToPath.size} unique blobs to fetch`)

mkdirSync(outputDir, { recursive: true })

const seen = new Map() // version -> filename
for (const [blobSha] of blobToPath) {
  let raw
  try {
    raw = git('cat-file', 'blob', blobSha) // fetches just this blob on-demand
  } catch {
    continue
  }

  let version
  try {
    version = JSON.parse(raw).info?.version
  } catch {
    continue
  }
  if (!version || seen.has(version)) continue

  writeFileSync(join(outputDir, `${version}.json`), raw)
  seen.set(version, `${version}.json`)
  console.error(`  ${version}`)
}

writeFileSync(
  join(outputDir, 'manifest.json'),
  JSON.stringify(Object.fromEntries(seen), null, 2) + '\n'
)

// Generate an index page so https://stripe-sync.dev/stripe-api-specs/ is browsable
const versions = [...seen.keys()].sort().reverse()
const rows = versions.map((v) => `    <li><a href="${seen.get(v)}">${v}</a></li>`).join('\n')
writeFileSync(
  join(outputDir, 'index.html'),
  `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Stripe REST API Specs — stripe-sync.dev CDN</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 700px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.4rem; }
    p { color: #555; }
    ul { list-style: none; padding: 0; }
    li { margin: .25rem 0; }
    a { color: #5469d4; text-decoration: none; font-family: monospace; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Stripe REST API OpenAPI Specs</h1>
  <p>
    These are the official <strong>Stripe REST API</strong> specs from
    <a href="https://github.com/stripe/openapi">github.com/stripe/openapi</a>,
    mirrored here to avoid GitHub API rate limits.
    This is <em>not</em> the Sync Engine's own OpenAPI spec
    (see <a href="/openapi/engine.json">engine.json</a> for that).
  </p>
  <p>Machine-readable index: <a href="manifest.json">manifest.json</a> — ${versions.length} versions available.</p>
  <ul>
${rows}
  </ul>
</body>
</html>
`
)

console.error(`\nDone: ${seen.size} spec versions from ${commits.length} commits`)
