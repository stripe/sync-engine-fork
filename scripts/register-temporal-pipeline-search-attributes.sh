#!/usr/bin/env bash
# Register Keyword search attributes used by pipelineWorkflow (see
# apps/service/src/temporal/pipeline-search-attributes.ts). Self-hosted
# Temporal does not include these; they must exist before workers run workflows
# that call upsertSearchAttributes.
#
# Usage (from the repo host, Temporal reachable on loopback):
#   ./scripts/register-temporal-pipeline-search-attributes.sh [ADDRESS]
# Default ADDRESS is 127.0.0.1:7233
set -euo pipefail

ADDR="${1:-127.0.0.1:7233}"
IMAGE="${TEMPORAL_ADMIN_TOOLS_IMAGE:-temporalio/admin-tools:latest}"

run_temporal() {
  docker run --rm --network=host "$IMAGE" temporal "$@"
}

run_temporal operator cluster health --address "$ADDR"

for name in SyncEnginePipelineStatus SyncEnginePipelineDesiredStatus; do
  run_temporal operator search-attribute create \
    --address "$ADDR" --namespace default \
    --name "$name" --type Keyword || true
done
