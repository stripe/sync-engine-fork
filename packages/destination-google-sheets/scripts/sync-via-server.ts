#!/usr/bin/env node
// POST /sync — reads from Stripe and writes to Google Sheets, looping until all
// streams are complete. Uses X-State-Checkpoint-Limit: 1 to process one page at
// a time, persisting the cursor to .state.json between pages.
//
// On completion, reads each sheet and prints the row count for each stream.
//
// Usage: npx tsx scripts/sync-via-server.ts [--port 3000]

import { google } from 'googleapis'
import {
  loadEnv,
  buildPipeline,
  requireEnv,
  loadState,
  saveState,
  getPort,
  STREAMS,
} from './_state.js'
import { readSheet } from '../src/writer.js'

loadEnv()
requireEnv('STRIPE_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN')

const state = loadState()
if (!state) {
  console.error('No sheet state found — run setup-via-server.ts first')
  process.exit(1)
}

const serverUrl = `http://localhost:${getPort()}`
console.error(`Sheet: https://docs.google.com/spreadsheets/d/${state.spreadsheet_id}`)

// Run one page of sync, returns updated syncState
async function runOnePage(syncState: Record<string, unknown>): Promise<Record<string, unknown>> {
  const pipeline = buildPipeline(state!.spreadsheet_id)
  const headers: Record<string, string> = {
    'X-Pipeline': JSON.stringify(pipeline),
    'X-State-Checkpoint-Limit': '1',
  }
  if (Object.keys(syncState).length > 0) {
    headers['X-State'] = JSON.stringify(syncState)
  }

  const res = await fetch(`${serverUrl}/sync`, { method: 'POST', headers })
  if (!res.ok && !res.body) {
    console.error(`Error: ${res.status} ${res.statusText}`)
    process.exit(1)
  }

  const updated = { ...syncState }
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      console.log(line)
      try {
        const msg = JSON.parse(line) as { type: string; stream?: string; data?: unknown }
        if (msg.type === 'state' && msg.stream) updated[msg.stream] = msg.data
      } catch {
        /* non-JSON line */
      }
    }
  }
  if (buf.trim()) {
    console.log(buf)
    try {
      const msg = JSON.parse(buf) as { type: string; stream?: string; data?: unknown }
      if (msg.type === 'state' && msg.stream) updated[msg.stream] = msg.data
    } catch {}
  }

  return updated
}

function isAllComplete(syncState: Record<string, unknown>): boolean {
  return STREAMS.every(
    (s) => (syncState[s] as { status?: string } | undefined)?.status === 'complete'
  )
}

// Loop until all streams are complete
let syncState: Record<string, unknown> = { ...(state.sync_state ?? {}) }
let page = 0

if (isAllComplete(syncState)) {
  console.error('All streams already complete. Reset sync_state to re-sync.')
  process.exit(0)
}

console.error('Starting sync loop...')

while (!isAllComplete(syncState)) {
  page++
  const pending = STREAMS.filter(
    (s) => (syncState[s] as { status?: string } | undefined)?.status !== 'complete'
  )
  console.error(`[page ${page}] Syncing: ${pending.join(', ')}`)

  syncState = await runOnePage(syncState)
  saveState({ spreadsheet_id: state.spreadsheet_id, sync_state: syncState })
}

console.error(`\nAll streams complete after ${page} page(s) — clearing sync cursor`)
saveState({ spreadsheet_id: state.spreadsheet_id })

// Read each sheet and print row counts
console.error('\nReading sheet row counts...')
const auth = new google.auth.OAuth2(
  process.env['GOOGLE_CLIENT_ID'],
  process.env['GOOGLE_CLIENT_SECRET']
)
auth.setCredentials({ refresh_token: process.env['GOOGLE_REFRESH_TOKEN'] })
const sheets = google.sheets({ version: 'v4', auth })

for (const stream of STREAMS) {
  try {
    const rows = await readSheet(sheets, state.spreadsheet_id, stream)
    // Subtract 1 for the header row
    const dataRows = Math.max(0, rows.length - 1)
    console.error(`  ${stream}: ${dataRows} rows`)
  } catch (err) {
    console.error(
      `  ${stream}: error reading sheet — ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
