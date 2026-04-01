// Shared helpers for the destination-google-sheets scripts.
// Loads .env and manages a local .state.json that acts as a fake DB for the sheet ID.

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATE_FILE = resolve(__dirname, '.state.json')

// ── Env loading ──────────────────────────────────────────────────────────────

export function loadEnv(): void {
  const envPath = resolve(__dirname, '../.env')
  try {
    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const value = trimmed.slice(eqIdx + 1).trim()
      if (!(key in process.env)) process.env[key] = value
    }
  } catch {
    // .env is optional
  }
}

// ── Sheet state ───────────────────────────────────────────────────────────────

export interface SheetState {
  spreadsheet_id: string
  /** Per-stream cursor state, persisted across sync calls for resumable pagination. */
  sync_state?: Record<string, unknown>
}

export function loadState(): SheetState | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as SheetState
  } catch {
    return null
  }
}

export function saveState(state: SheetState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
  console.error(`Saved state → ${STATE_FILE}`)
}

export function clearState(): void {
  try {
    unlinkSync(STATE_FILE)
    console.error(`Cleared state (${STATE_FILE})`)
  } catch {
    // already gone
  }
}

// ── Pipeline builder ──────────────────────────────────────────────────────────

export function buildDestinationConfig(spreadsheetId?: string): Record<string, unknown> {
  return {
    name: 'google-sheets',
    client_id: process.env['GOOGLE_CLIENT_ID'],
    client_secret: process.env['GOOGLE_CLIENT_SECRET'],
    access_token: 'unused',
    refresh_token: process.env['GOOGLE_REFRESH_TOKEN'],
    ...(spreadsheetId ? { spreadsheet_id: spreadsheetId } : {}),
  }
}

export const STREAMS = ['products', 'customers', 'prices', 'subscriptions'] as const

export function buildPipeline(spreadsheetId?: string): Record<string, unknown> {
  return {
    source: { name: 'stripe', api_key: process.env['STRIPE_API_KEY'], backfill_limit: 10 },
    destination: buildDestinationConfig(spreadsheetId),
    streams: STREAMS.map((name) => ({ name })),
  }
}

export function requireEnv(...keys: string[]): void {
  const missing = keys.filter((k) => !process.env[k])
  if (missing.length > 0) {
    console.error(`Error: missing required env vars: ${missing.join(', ')}`)
    process.exit(1)
  }
}

export function getPort(): string {
  const idx = process.argv.indexOf('--port')
  return idx !== -1 ? process.argv[idx + 1] : '3000'
}
