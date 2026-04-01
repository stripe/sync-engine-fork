#!/usr/bin/env node
// POST /setup — creates a new Google Sheet, saves its ID to .state.json
// Usage: npx tsx scripts/setup-via-server.ts [--port 3000]

import { loadEnv, buildPipeline, requireEnv, saveState, getPort } from './_state.js'

loadEnv()
requireEnv('STRIPE_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN')

const serverUrl = `http://localhost:${getPort()}`

// No spreadsheet_id — setup always creates a new sheet
const pipeline = buildPipeline()

console.error(`Hitting ${serverUrl}/setup ...`)

const res = await fetch(`${serverUrl}/setup`, {
  method: 'POST',
  headers: { 'X-Pipeline': JSON.stringify(pipeline) },
})

if (res.status === 200) {
  const result = (await res.json()) as { spreadsheet_id: string }
  saveState({ spreadsheet_id: result.spreadsheet_id })
  console.log(JSON.stringify(result, null, 2))
} else {
  const body = await res.text()
  console.error(`Error: ${res.status} ${res.statusText}`)
  if (body) console.error(body)
  process.exit(1)
}
