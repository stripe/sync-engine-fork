#!/usr/bin/env bash
# Pull and start the sync-engine Docker image from Docker Hub on port 4020.
# Usage: ./scripts/pull-and-start-engine.sh [--pull-only | --no-pull | --pretty]

set -euo pipefail

IMAGE="stripe/sync-engine:v2"
CONTAINER_NAME="sync-engine"
HOST_PORT="${PORT:-4020}"

pull() {
  echo "Pulling ${IMAGE}…"
  docker pull "${IMAGE}"
}

run() {
  # Remove any existing container with the same name
  if docker container inspect "${CONTAINER_NAME}" &>/dev/null; then
    echo "Removing existing ${CONTAINER_NAME} container…"
    docker rm -f "${CONTAINER_NAME}"
  fi

  echo "Starting ${CONTAINER_NAME} on port ${HOST_PORT}…"
  docker run --rm -it \
    --name "${CONTAINER_NAME}" \
    -p "${HOST_PORT}:3000" \
    --env-file <(env | grep -E '^(STRIPE_|DATABASE_|STATE_)' 2>/dev/null || true) \
    "${IMAGE}"
}

case "${1:-}" in
  --pull-only) pull ;;
  --no-pull)   run ;;
  --pretty)    pull && run 2>&1 | npx pino-pretty ;;
  *)           pull && run ;;
esac
