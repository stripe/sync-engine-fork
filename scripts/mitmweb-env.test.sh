#!/bin/bash
# Test that mitmweb-env.sh correctly routes traffic through mitmweb.
# Requires mitmweb to already be running, or the env script will start it.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/mitmweb-env.sh"

PASS=0
FAIL=0
TARGET="https://httpbin.org/get"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Run all three fetches in parallel
curl -sk --max-time 15 "$TARGET" > "$TMP/curl.out" 2>&1 &
PID_CURL=$!

timeout 15 node -e "
  fetch('$TARGET').then(r=>r.json()).then(j=>console.log(JSON.stringify(j))).catch(e=>console.error(e.message))
" > "$TMP/node.out" 2>&1 &
PID_NODE=$!

timeout 15 bun -e "
  const r = await fetch('$TARGET');
  const j = await r.json();
  console.log(JSON.stringify(j));
" > "$TMP/bun.out" 2>&1 &
PID_BUN=$!

wait $PID_CURL $PID_NODE $PID_BUN 2>/dev/null

echo ""
for runtime in curl node bun; do
  file="$TMP/$runtime.out"
  origin=$(grep -o '"origin":\s*"[^"]*"' "$file" 2>/dev/null | head -1 | cut -d'"' -f4)
  if [ -z "$origin" ]; then
    # try spaced json format
    origin=$(grep -o '"origin": "[^"]*"' "$file" 2>/dev/null | head -1 | cut -d'"' -f4)
  fi
  if [ -n "$origin" ]; then
    echo "PASS: $runtime (origin=$origin)"
    ((PASS++))
  else
    echo "FAIL: $runtime"
    echo "  output: $(head -5 "$file" 2>/dev/null)"
    ((FAIL++))
  fi
done

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
[ "$FAIL" -eq 0 ]
