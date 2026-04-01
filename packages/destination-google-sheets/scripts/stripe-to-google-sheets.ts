#!/usr/bin/env node
// Sync Stripe → Google Sheets via the sync-engine CLI.
// Reads credentials from packages/destination-google-sheets/.env
//
// Usage: npx tsx scripts/stripe-to-google-sheets.ts
//   or:  node --import tsx scripts/stripe-to-google-sheets.ts

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env from the package root
const envPath = resolve(__dirname, '../.env')
try {
  const envContent = readFileSync(envPath, 'utf-8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim()
    if (!(key in process.env)) process.env[key] = value
  }
} catch {
  // .env is optional; env vars may already be set
}

const {
  STRIPE_API_KEY,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  GOOGLE_SPREADSHEET_ID,
} = process.env

if (!STRIPE_API_KEY) {
  console.error('Error: STRIPE_API_KEY is required (set it in .env or the environment)')
  process.exit(1)
}

// Fetch Stripe account ID
const accountRes = await fetch('https://api.stripe.com/v1/account', {
  headers: {
    Authorization: `Basic ${Buffer.from(`${STRIPE_API_KEY}:`).toString('base64')}`,
  },
})
const account = (await accountRes.json()) as { id: string }
console.error(`Stripe: ${account.id}`)
console.error(`Sheet: https://docs.google.com/spreadsheets/d/${GOOGLE_SPREADSHEET_ID}`)

const pipeline = JSON.stringify({
  source: { name: 'stripe', api_key: STRIPE_API_KEY, backfill_limit: 10 },
  destination: {
    name: 'google-sheets',
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    access_token: 'unused',
    refresh_token: GOOGLE_REFRESH_TOKEN,
    spreadsheet_id: GOOGLE_SPREADSHEET_ID,
  },
  streams: [{ name: 'products' }, { name: 'customers' }],
})

const repoRoot = resolve(__dirname, '../../..')
const cliPath = resolve(repoRoot, 'apps/engine/src/cli/index.ts')

// Use bun if available, else tsx
function hasBun(): boolean {
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')
const [cmd, ...cmdArgs] = hasBun() ? ['bun', cliPath] : [tsxBin, cliPath]

const result = spawnSync(cmd, [...cmdArgs, 'sync', '--xPipeline', pipeline], {
  stdio: 'inherit',
  cwd: repoRoot,
})

process.exit(result.status ?? 1)
