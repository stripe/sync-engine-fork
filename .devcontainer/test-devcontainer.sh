#!/usr/bin/env bash
# Validation script for the dev container setup.
# Run inside the dev container to verify all services are reachable
# and the development toolchain is functional.
#
# Usage: bash .devcontainer/test-devcontainer.sh

set -euo pipefail

PASS=0
FAIL=0

check() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  PASS  $label"
    ((PASS++))
  else
    echo "  FAIL  $label"
    ((FAIL++))
  fi
}

echo "=== Dev Container Validation ==="
echo ""

# --- Toolchain ---
echo "Toolchain:"
check "Node.js >= 24" node -e "assert(parseInt(process.versions.node) >= 24)"
check "pnpm available" pnpm --version
check "TypeScript available" pnpm exec tsc --version
check "corepack enabled" corepack --version

echo ""

# --- Service connectivity ---
echo "Services:"
check "Postgres (postgres:5432)" pg_isready -h postgres -p 5432 -U postgres
check "stripe-mock (stripe-mock:12111)" nc -z stripe-mock 12111
check "Temporal gRPC (temporal:7233)" nc -z temporal 7233

echo ""

# --- Database ---
echo "Database:"
check "Postgres connection" psql "$DATABASE_URL" -c "SELECT 1"
check "stripe schema" psql "$POSTGRES_URL" -c "CREATE SCHEMA IF NOT EXISTS stripe"

echo ""

# --- Stripe mock ---
echo "Stripe Mock:"
check "GET /v1/customers" curl -sf -H "Authorization: Bearer sk_test_fake123" http://stripe-mock:12111/v1/customers

echo ""

# --- Build artifacts ---
echo "Build:"
check "node_modules exists" test -d node_modules
check "Build output exists" test -d packages/protocol/dist

echo ""

# --- Environment variables ---
echo "Environment:"
check "DATABASE_URL set" test -n "${DATABASE_URL:-}"
check "STRIPE_MOCK_URL set" test -n "${STRIPE_MOCK_URL:-}"
check "TEMPORAL_ADDRESS set" test -n "${TEMPORAL_ADDRESS:-}"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1
