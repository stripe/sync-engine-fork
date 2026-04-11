# Dev container image for sync-engine
FROM mcr.microsoft.com/devcontainers/javascript-node:24

# Enable corepack so pnpm is available at the version specified in package.json
RUN corepack enable

# Install CLI tools useful for development and service health checks
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*
