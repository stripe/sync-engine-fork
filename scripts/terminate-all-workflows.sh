#!/usr/bin/env bash
# Terminate all open Temporal workflow executions.
#
# Usage:
#   ./scripts/terminate-all-workflows.sh [--address localhost:7233] [--namespace default] [--reason "..."]
#
# Defaults: address=localhost:7233, namespace=default

set -euo pipefail

ADDRESS="localhost:7233"
NAMESPACE="default"
REASON="bulk terminate via terminate-all-workflows.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --address)   ADDRESS="$2";   shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --reason)    REASON="$2";    shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

echo "Terminating all open workflows on $ADDRESS (namespace: $NAMESPACE)..."

temporal workflow terminate \
  --address "$ADDRESS" \
  --namespace "$NAMESPACE" \
  --query 'ExecutionStatus="Running"' \
  --reason "$REASON" \
  --yes
