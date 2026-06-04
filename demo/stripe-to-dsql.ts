/**
 * Sync Stripe → AWS DSQL via the engine API (TypeScript).
 *
 * Usage:
 *   npx tsx demo/stripe-to-dsql.ts
 *   bun demo/stripe-to-dsql.ts
 *
 * Env:
 *   STRIPE_API_KEY           — Stripe secret key
 *   DSQL_ENDPOINT            — DSQL cluster endpoint (e.g. <id>.dsql.us-east-1.on.aws)
 *   AWS_REGION               — AWS region (default: us-east-1)
 *   AWS_ACCESS_KEY_ID        — AWS credentials
 *   AWS_SECRET_ACCESS_KEY    — AWS credentials
 */
import { execSync } from 'node:child_process'
import { createConnectorResolver, createEngine } from '../apps/engine/src/lib/index.js'
import { defaultConnectors } from '../apps/engine/src/lib/default-connectors.js'
import { fileStateStore } from '../apps/engine/src/lib/state-store.js'
import type { PipelineConfig } from '../packages/protocol/src/index.js'
import { buildPoolConfig, pg } from '../packages/destination-aws-dsql/src/index.js'

const stripeApiKey = process.env.STRIPE_API_KEY
const region = process.env.AWS_REGION ?? 'us-east-1'

// Auto-read endpoint from terraform output if not set
const dsqlEndpoint =
  process.env.DSQL_ENDPOINT ??
  (() => {
    try {
      return execSync('terraform -chdir=terraform output -raw cluster_endpoint', {
        encoding: 'utf8',
      }).trim()
    } catch {
      return undefined
    }
  })()

if (!stripeApiKey) throw new Error('Set STRIPE_API_KEY')
if (!dsqlEndpoint)
  throw new Error('Set DSQL_ENDPOINT or run `terraform -chdir=terraform apply` first')

const pipeline: PipelineConfig = {
  source: { type: 'stripe', stripe: { api_key: stripeApiKey, backfill_limit: 10 } },
  destination: {
    type: 'aws_dsql',
    aws_dsql: { endpoint: dsqlEndpoint, region, schema: 'public' },
  },
  streams: [{ name: 'products' }, { name: 'prices' }, { name: 'customers' }],
}

const resolver = await createConnectorResolver(defaultConnectors, { path: true })
const engine = await createEngine(resolver)

// Create tables
for await (const _msg of engine.pipeline_setup(pipeline)) {
}

// State: file-backed, resumable across runs
const store = fileStateStore('.sync-state-dsql.json')
const state = await store.get()

// Sync
for await (const msg of engine.pipeline_sync(pipeline, { state })) {
  if (msg.type === 'source_state') {
    if (msg.source_state.state_type === 'global') await store.setGlobal(msg.source_state.data)
    else await store.set(msg.source_state.stream, msg.source_state.data)
  }
  console.log(JSON.stringify(msg))
}

// Verify: query DSQL to show what was synced
console.log('\n--- Verifying data in DSQL ---')
const poolConfig = await buildPoolConfig({
  endpoint: dsqlEndpoint,
  region,
  schema: 'public',
  batch_size: 100,
})
const pool = new pg.Pool(poolConfig)

for (const table of ['customers', 'prices', 'products']) {
  const { rows } = await pool.query(`SELECT count(*) FROM ${table}`)
  console.log(`${table}: ${rows[0].count} rows`)
}

console.log('\nSample rows:')
for (const table of ['customers', 'products']) {
  const { rows } = await pool.query(
    `SELECT id, substring(_raw_data, 1, 100) as data FROM ${table} LIMIT 2`
  )
  for (const row of rows) console.log(`  [${table}] ${row.id}: ${row.data}...`)
}

await pool.end()
