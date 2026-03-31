#!/usr/bin/env node
/**
 * Fetches every published Stripe REST API spec version from GitHub and writes
 * <version>.json + manifest.json to <outputDir>.
 *
 * Usage:
 *   node generate-stripe-specs.mjs <outputDir>
 *
 * The output lands at docs/out/stripe-api-specs/ during the Vercel build and
 * is served from stripe-sync.dev/stripe-api-specs — no GitHub rate limits for consumers.
 *
 * These are the official Stripe REST API specs (github.com/stripe/openapi), NOT
 * the Sync Engine's own OpenAPI spec (which lives at /openapi/engine.json etc.).
 *
 * Uses the GitHub REST API + raw.githubusercontent.com (no git clone required).
 * Set GITHUB_TOKEN / GH_TOKEN to avoid the 60 req/h unauthenticated rate limit.
 *
 * No npm dependencies.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const [outputDir] = process.argv.slice(2)
if (!outputDir) {
  console.error('Usage: node generate-stripe-specs.mjs <outputDir>')
  process.exit(1)
}

const OWNER = 'stripe'
const REPO = 'openapi'
// Both historic and current spec paths in the stripe/openapi repo
const SPEC_PATHS = ['latest/openapi.spec3.sdk.json', 'openapi/spec3.json']
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN

function githubHeaders() {
  const h = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'stripe-sync-engine-spec-generator',
  }
  if (TOKEN) h['Authorization'] = `Bearer ${TOKEN}`
  return h
}

async function githubApi(path) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    headers: githubHeaders(),
  })
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${path}: ${await res.text()}`)
  }
  return res.json()
}

async function fetchRaw(sha, specPath) {
  const url = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${sha}/${specPath}`
  const res = await fetch(url, { headers: { 'User-Agent': 'stripe-sync-engine-spec-generator' } })
  return res.ok ? res.text() : null
}

// Collect all commits that touched either spec path (paginated).
// stripe/openapi uses 'latest/openapi.spec3.sdk.json' for recent specs and
// 'openapi/spec3.json' for historic ones — query both and deduplicate.
console.error('Fetching commit list from GitHub API...')
const seenShas = new Set()
const allShas = []
for (const specPath of SPEC_PATHS) {
  for (let page = 1; ; page++) {
    const commits = await githubApi(`/commits?path=${specPath}&per_page=100&page=${page}`)
    for (const c of commits) {
      if (!seenShas.has(c.sha)) {
        seenShas.add(c.sha)
        allShas.push(c.sha)
      }
    }
    if (commits.length < 100) break
  }
}
console.error(`  ${allShas.length} commits to scan`)

mkdirSync(outputDir, { recursive: true })

const seen = new Map()
for (const sha of allShas) {
  let raw = null
  for (const specPath of SPEC_PATHS) {
    raw = await fetchRaw(sha, specPath)
    if (raw) break
  }
  if (!raw) continue

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

console.error(`\nDone: ${seen.size} spec versions from ${allShas.length} commits`)
