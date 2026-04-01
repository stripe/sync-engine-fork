#!/usr/bin/env node
// Calculates total cell count across all sheets in the saved spreadsheet.
//
// Usage: npx tsx scripts/sheet-size.ts

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { google } from 'googleapis'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env
const envPath = resolve(__dirname, '../.env')
try {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim()
    if (!(key in process.env)) process.env[key] = value
  }
} catch {
  /* .env is optional */
}

// Load spreadsheet ID from .state.json
const stateFile = resolve(__dirname, '.state.json')
let spreadsheetId: string
try {
  const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as { spreadsheet_id: string }
  spreadsheetId = state.spreadsheet_id
} catch {
  console.error('No .state.json found — run setup-via-server.ts first')
  process.exit(1)
}

const auth = new google.auth.OAuth2(
  process.env['GOOGLE_CLIENT_ID'],
  process.env['GOOGLE_CLIENT_SECRET']
)
auth.setCredentials({ refresh_token: process.env['GOOGLE_REFRESH_TOKEN'] })
const sheets = google.sheets({ version: 'v4', auth })

// Fetch spreadsheet metadata (includes all sheet grid properties)
const res = await sheets.spreadsheets.get({
  spreadsheetId,
  fields: 'sheets(properties(title,gridProperties))',
})

console.error(`Sheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}\n`)

let grandTotal = 0
for (const sheet of res.data.sheets ?? []) {
  const title = sheet.properties?.title ?? '(untitled)'
  const { rowCount = 0, columnCount = 0 } = sheet.properties?.gridProperties ?? {}
  const cells = rowCount * columnCount
  grandTotal += cells
  console.error(
    `  ${title}: ${rowCount} rows × ${columnCount} cols = ${cells.toLocaleString()} cells`
  )
}

console.error(`\n  Total: ${grandTotal.toLocaleString()} cells`)
