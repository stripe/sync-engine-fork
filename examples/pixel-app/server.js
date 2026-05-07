/**
 * PixelDraw — Metronome + Redis entitlement demo.
 *
 * Each pixel drawn sends a usage event to Metronome (color = event type).
 * Credit balance is checked in Redis — synced from Metronome via sync-engine.
 * NO local state in Redis. The only data is replicated from Metronome.
 *
 * Architecture:
 *   Browser → POST /api/draw → check Metronome-synced Redis balance → send usage to Metronome
 *   Metronome → webhook → source-metronome → destination-redis (keeps Redis fresh)
 *
 * Env vars:
 *   METRONOME_API_TOKEN   — Metronome bearer token
 *   METRONOME_CUSTOMER_ID — Customer ID in Metronome
 *   REDIS_URL             — Redis connection (default: redis://localhost:56379)
 *   PORT                  — Server port (default: 4000)
 */

import express from 'express'
import { Redis } from 'ioredis'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = express()
app.use(express.json())
app.use(express.static(join(__dirname, 'public')))

const PORT = process.env.PORT || 4000
const METRONOME_API_TOKEN = process.env.METRONOME_API_TOKEN
const METRONOME_CUSTOMER_ID = process.env.METRONOME_CUSTOMER_ID
const METRONOME_BASE_URL = process.env.METRONOME_BASE_URL || 'https://api.metronome.com'
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:56379'
const KEY_PREFIX = process.env.KEY_PREFIX || 'sync:'

if (!METRONOME_API_TOKEN) {
  console.error('ERROR: Set METRONOME_API_TOKEN')
  process.exit(1)
}
if (!METRONOME_CUSTOMER_ID) {
  console.error('ERROR: Set METRONOME_CUSTOMER_ID')
  process.exit(1)
}

const redis = new Redis(REDIS_URL)

// ---- Redis reads (Metronome-synced data only) ----

/** Get credit balance from Metronome-synced grant data in Redis */
async function getCreditBalance() {
  const keys = await scanKeys(`${KEY_PREFIX}credit_grants:*`)
  let balance = 0

  for (const key of keys) {
    const raw = await redis.get(key)
    if (!raw) continue
    const grant = JSON.parse(raw)
    if (grant.customer_id !== METRONOME_CUSTOMER_ID) continue
    balance += grant.balance?.including_pending ?? 0
  }

  return balance
}

/** Get entitlement for a specific product from Redis */
async function getEntitlement(productName) {
  const keys = await scanKeys(`${KEY_PREFIX}entitlements:${METRONOME_CUSTOMER_ID}:*`)
  for (const key of keys) {
    const raw = await redis.get(key)
    if (!raw) continue
    const ent = JSON.parse(raw)
    if (ent.product_name === productName) {
      return ent
    }
  }
  return null
}

/** Scan Redis keys matching a pattern */
async function scanKeys(pattern) {
  const keys = []
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
    cursor = next
    keys.push(...batch)
  } while (cursor !== '0')
  return keys
}

// ---- Metronome usage ingestion ----

async function ingestUsage(color) {
  const res = await fetch(`${METRONOME_BASE_URL}/v1/ingest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${METRONOME_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      {
        customer_id: METRONOME_CUSTOMER_ID,
        event_type: 'pixel_draw',
        timestamp: new Date().toISOString(),
        transaction_id: `px_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        properties: { color },
      },
    ]),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Metronome ingest failed: ${res.status} ${text}`)
  }
}

// ---- API routes ----

/** Health check */
app.get('/api/health', async (_req, res) => {
  try {
    await redis.ping()
    res.json({ ok: true, redis: 'connected' })
  } catch {
    res.status(503).json({ ok: false, redis: 'disconnected' })
  }
})

/** Get current credit balance + entitlements from Metronome-synced Redis */
app.get('/api/credits', async (_req, res) => {
  const balance = await getCreditBalance()
  const entitlement = await getEntitlement('API Access')
  res.json({
    balance,
    entitled: entitlement?.entitled ?? false,
    product: entitlement?.product_name ?? null,
  })
})

/** Draw a pixel — the hot path */
app.post('/api/draw', async (req, res) => {
  const { color, x, y } = req.body
  if (!color || x == null || y == null) {
    return res.status(400).json({ error: 'color, x, y required' })
  }

  // 1. Check Metronome-synced credit balance in Redis
  const balance = await getCreditBalance()
  if (balance <= 0) {
    return res.status(402).json({
      allowed: false,
      error: 'Out of credits',
      balance: 0,
    })
  }

  // 2. Send usage event to Metronome (async, don't block response)
  ingestUsage(color).catch((err) => {
    console.error('Usage ingest error:', err.message)
  })

  res.json({
    allowed: true,
    balance,
    color,
    x,
    y,
  })
})

// ---- Start ----

app.listen(PORT, () => {
  console.log(`
+==================================================+
|  PixelDraw — http://localhost:${PORT}              |
|  Metronome customer: ${METRONOME_CUSTOMER_ID.slice(0, 20)}...    |
|  Redis: ${REDIS_URL.padEnd(42)}|
|  Balance: Metronome-synced only (no local state) |
|  Usage sent to Metronome (async)                 |
+==================================================+
  `)
})
