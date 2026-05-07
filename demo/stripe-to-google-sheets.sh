#!/usr/bin/env bash
# Sync Stripe → Google Sheets via the sync-engine CLI.
#
# Usage:
#   ./demo/stripe-to-google-sheets.sh
#
# Env: STRIPE_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
# Optional: GOOGLE_SPREADSHEET_ID (creates new sheet if omitted)
# Override TypeScript runner: TS_RUNNER="bun" or TS_RUNNER="npx tsx"
set -euo pipefail
cd "$(dirname "$0")/.."
RUN="${TS_RUNNER:-node --import tsx}"

echo "=== Stripe → Google Sheets ===" >&2

PIPELINE=$(node -e "console.log(JSON.stringify({
  source: {
    type: 'stripe',
    stripe: {
      api_key: process.env.STRIPE_API_KEY,
      backfill_limit: 10,
    },
  },
  destination: {
    type: 'google_sheets',
    google_sheets: {
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      access_token: 'unused',
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      spreadsheet_id: process.env.GOOGLE_SPREADSHEET_ID || undefined,
      spreadsheet_title: 'Stripe Sync Demo',
      batch_size: 50,
    },
  },
  streams: [
    { name: 'customers' },      // → New Customers by Month chart
    { name: 'subscriptions' },  // → Subscription Status chart; joins with invoices
    { name: 'invoices' },       // → Invoice Revenue by Subscription Status chart (multi-table)
    { name: 'payment_intents' },// → Payment Volume by Status + Revenue by Currency charts
    { name: 'products' },       // → Products: Active vs Archived chart
    { name: 'prices' },         // commonly paired with subscriptions
  ],
}))")

echo "--- Setup ---" >&2
SETUP_NDJSON=$(mktemp)
$RUN apps/engine/src/bin/sync-engine.ts api pipeline pipeline-setup --pipeline "$PIPELINE" | tee "$SETUP_NDJSON"

# If setup created a new spreadsheet, extract its ID and inject into pipeline
NEW_ID=$(node -e "
  const fs = require('fs');
  const lines = fs.readFileSync('$SETUP_NDJSON', 'utf8').trim().split('\n');
  for (const line of lines) {
    try {
      const m = JSON.parse(line);
      if (m.type === 'control' && m.control?.control_type === 'destination_config') {
        process.stdout.write(m.control.destination_config?.spreadsheet_id ?? '');
        break;
      }
    } catch {}
  }
" 2>/dev/null || true)
rm -f "$SETUP_NDJSON"

if [ -n "$NEW_ID" ]; then
  PIPELINE=$(node -e "
    const p = JSON.parse(process.argv[1]);
    p.destination.google_sheets.spreadsheet_id = process.argv[2];
    console.log(JSON.stringify(p));
  " "$PIPELINE" "$NEW_ID")
fi

SPREADSHEET_ID=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).destination.google_sheets.spreadsheet_id ?? '')" "$PIPELINE")
[ -n "$SPREADSHEET_ID" ] && echo "Sheet: https://docs.google.com/spreadsheets/d/$SPREADSHEET_ID" >&2

echo "--- Sync ---" >&2
$RUN apps/engine/src/bin/sync-engine.ts api pipeline pipeline-sync --pipeline "$PIPELINE"
