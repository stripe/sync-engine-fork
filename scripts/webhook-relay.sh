#!/usr/bin/env bash
# Poll webhook.site for new requests and forward them to a local server.
# Usage: ./scripts/webhook-relay.sh <webhook-site-token> <local-url>
set -euo pipefail

TOKEN="${1:?Usage: webhook-relay.sh <webhook-site-token> <local-url>}"
TARGET="${2:-http://localhost:4243}"
SEEN=""

echo "Relaying webhook.site/$TOKEN → $TARGET"
echo "Polling every 2 seconds..."

while true; do
  REQUESTS=$(curl -s "https://webhook.site/token/$TOKEN/requests?sorting=newest&per_page=5" 2>/dev/null)

  # Extract request UUIDs and process new ones
  echo "$REQUESTS" | python3 -c "
import sys, json, subprocess

data = json.load(sys.stdin)
seen = set('''$SEEN'''.split())

for req in reversed(data.get('data', [])):
    uuid = req['uuid']
    if uuid in seen:
        continue

    # Forward the request body + headers to target
    body = req.get('content', '') or '{}'
    headers = req.get('headers', {})

    cmd = ['curl', '-s', '-X', 'POST', '$TARGET', '-H', 'Content-Type: application/json']

    # Forward relevant headers
    for key in ['date', 'metronome-webhook-signature']:
        for hdr_key, hdr_vals in headers.items():
            if hdr_key.lower() == key and hdr_vals:
                val = hdr_vals[0] if isinstance(hdr_vals, list) else hdr_vals
                cmd.extend(['-H', f'{hdr_key}: {val}'])

    cmd.extend(['-d', body])

    result = subprocess.run(cmd, capture_output=True, text=True)
    print(f'Relayed {uuid[:8]}... → {result.stdout[:80]}')
    print(uuid)  # Print UUID so we can track it
" 2>/dev/null | while IFS= read -r line; do
    if [[ "$line" =~ ^[0-9a-f]{8}-[0-9a-f]{4} ]]; then
      SEEN="$SEEN $line"
    else
      echo "$line"
    fi
  done

  sleep 2
done
