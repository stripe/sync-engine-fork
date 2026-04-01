#!/usr/bin/env node
// POST /teardown — permanently deletes the Google Sheet and clears local state
// Usage: npx tsx scripts/teardown-via-server.ts [--port 3000]

import { loadEnv, buildPipeline, requireEnv, loadState, clearState, getPort } from './_state.js'

loadEnv()
requireEnv('STRIPE_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN')

const state = loadState()
if (!state) {
  console.error('No sheet state found — nothing to tear down')
  process.exit(1)
}

const serverUrl = `http://localhost:${getPort()}`
const pipeline = buildPipeline(state.spreadsheet_id)

console.error(`Hitting ${serverUrl}/teardown ...`)
console.error(`Deleting sheet: https://docs.google.com/spreadsheets/d/${state.spreadsheet_id}`)

const res = await fetch(`${serverUrl}/teardown`, {
  method: 'POST',
  headers: { 'X-Pipeline': JSON.stringify(pipeline) },
})

if (res.status === 204) {
  clearState()
  console.error('Teardown complete')
} else {
  const body = await res.text()
  console.error(`Error: ${res.status} ${res.statusText}`)
  if (body) console.error(body)
  process.exit(1)
}
