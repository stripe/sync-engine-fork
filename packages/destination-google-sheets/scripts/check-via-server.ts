#!/usr/bin/env node
// GET /check — validates credentials and sheet accessibility
// Usage: npx tsx scripts/check-via-server.ts [--port 3000]

import { loadEnv, buildPipeline, requireEnv, loadState, getPort } from './_state.js'

loadEnv()
requireEnv('STRIPE_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN')

const state = loadState()
if (!state) {
  console.error('No sheet state found — run setup-via-server.ts first')
  process.exit(1)
}

const serverUrl = `http://localhost:${getPort()}`
const pipeline = buildPipeline(state.spreadsheet_id)

console.error(`Hitting ${serverUrl}/check ...`)
console.error(`Sheet: https://docs.google.com/spreadsheets/d/${state.spreadsheet_id}`)

const res = await fetch(`${serverUrl}/check`, {
  headers: { 'X-Pipeline': JSON.stringify(pipeline) },
})

const result = await res.json()
console.log(JSON.stringify(result, null, 2))

if (res.status !== 200) process.exit(1)
