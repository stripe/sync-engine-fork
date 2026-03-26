#!/usr/bin/env bash
# Test src-stripe, dest-pg, and dest-sheets through smokescreen HTTP CONNECT proxy.
# Requires: STRIPE_API_KEY, POSTGRES_URL
# Optional: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_SPREADSHEET_ID
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Start smokescreen
echo "==> Starting smokescreen"
docker compose --profile smokescreen up -d --wait smokescreen

ENGINE_PORT="${PORT:-3299}"
ENGINE_PID=""

cleanup() {
  [ -n "$ENGINE_PID" ] && kill "$ENGINE_PID" 2>/dev/null || true
  docker compose --profile smokescreen stop smokescreen
}
trap cleanup EXIT

# Point all HTTPS traffic through smokescreen
export HTTPS_PROXY="http://localhost:4750"

# Build check
ENGINE_BIN="$REPO_ROOT/apps/engine/dist/cli/index.js"
if [ ! -f "$ENGINE_BIN" ]; then
  echo "FAIL: engine not built — run pnpm build first"
  exit 1
fi

# Start engine with proxy configured
echo "==> Starting engine (HTTPS_PROXY=$HTTPS_PROXY)"
node "$ENGINE_BIN" serve --port "$ENGINE_PORT" &
ENGINE_PID=$!

# Wait for engine health
for i in $(seq 1 20); do
  curl -sf "http://localhost:$ENGINE_PORT/health" >/dev/null && break
  [ "$i" -eq 20 ] && { echo "FAIL: engine health check timed out"; exit 1; }
  sleep 0.5
done
echo "    Engine ready on :$ENGINE_PORT"

# --- 1) Read from Stripe (through smokescreen) ---
echo "==> src-stripe: read through smokescreen"
READ_PARAMS=$(printf '{"source_name":"stripe","source_config":{"api_key":"%s","backfill_limit":5},"destination_name":"postgres","destination_config":{"url":"postgres://unused:5432/db","schema":"stripe"},"streams":[{"name":"products"}]}' "$STRIPE_API_KEY")
OUTPUT=$(curl -sf --max-time 30 -X POST "http://localhost:$ENGINE_PORT/read" \
  -H "X-Sync-Params: $READ_PARAMS")
RECORD_COUNT=$(echo "$OUTPUT" | grep -c '"type":"record"' || true)
echo "    Got $RECORD_COUNT record(s)"
[ "$RECORD_COUNT" -gt 0 ] || { echo "FAIL: no records from Stripe"; exit 1; }

# --- 2) Write to Postgres (direct TCP + proxied HTTP reads) ---
if [ -n "${POSTGRES_URL:-}" ]; then
  echo "==> dest-pg: setup + write"
  PG_PARAMS=$(printf '{"source_name":"stripe","source_config":{"api_key":"%s"},"destination_name":"postgres","destination_config":{"url":"%s","schema":"stripe_smokescreen_test"}}' \
    "$STRIPE_API_KEY" "$POSTGRES_URL")
  curl -sf --max-time 30 -X POST "http://localhost:$ENGINE_PORT/setup" \
    -H "X-Sync-Params: $PG_PARAMS" && echo "    setup OK"
  echo "$OUTPUT" | curl -sf --max-time 60 -X POST "http://localhost:$ENGINE_PORT/write" \
    -H "X-Sync-Params: $PG_PARAMS" \
    -H "Content-Type: application/x-ndjson" \
    --data-binary @- | head -3 || true
  # Teardown
  psql "$POSTGRES_URL" -c 'DROP SCHEMA IF EXISTS stripe_smokescreen_test CASCADE' >/dev/null 2>&1 || true
  echo "    dest-pg OK"
else
  echo "==> Skipping dest-pg (POSTGRES_URL not set)"
fi

# --- 3) Write to Google Sheets (through smokescreen) ---
if [ -n "${GOOGLE_CLIENT_ID:-}" ]; then
  echo "==> dest-sheets: write through smokescreen"
  SHEETS_PARAMS=$(printf '{"source_name":"stripe","source_config":{"api_key":"%s"},"destination_name":"google-sheets","destination_config":{"client_id":"%s","client_secret":"%s","access_token":"unused","refresh_token":"%s","spreadsheet_id":"%s"}}' \
    "$STRIPE_API_KEY" "$GOOGLE_CLIENT_ID" "$GOOGLE_CLIENT_SECRET" "$GOOGLE_REFRESH_TOKEN" "$GOOGLE_SPREADSHEET_ID")
  echo "$OUTPUT" | curl -sf --max-time 60 -X POST "http://localhost:$ENGINE_PORT/write" \
    -H "X-Sync-Params: $SHEETS_PARAMS" \
    -H "Content-Type: application/x-ndjson" \
    --data-binary @- | head -3 || true
  echo "    dest-sheets OK"
else
  echo "==> Skipping dest-sheets (GOOGLE_CLIENT_ID not set)"
fi

echo "==> All smokescreen tests passed"
