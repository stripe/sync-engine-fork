# Builds the @stripe/sync-engine image (stateless HTTP engine API).
# Build context must be the repo root: docker build -f apps/engine/Dockerfile .

# ---- Manifests stage ----
# Extracts all package.json / lockfile / workspace config files via find so no
# per-package COPY line needs updating when a new workspace package is added.
FROM node:24-alpine AS manifests
WORKDIR /app
COPY . .
RUN find . \
      \( -name 'package.json' -o -name 'pnpm-workspace.yaml' -o -name 'pnpm-lock.yaml' \) \
      -not -path '*/node_modules/*' -not -path '*/.git/*' \
      -exec sh -c 'dst="/m/$1"; mkdir -p "$(dirname "$dst")"; cp "$1" "$dst"' _ {} \;

FROM node:24-alpine AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app

# ---- Install layer (cached by BuildKit registry cache) ----
# Seeded from the manifests stage — cache survives source-only changes.
COPY --from=manifests /m/ ./
RUN pnpm install --frozen-lockfile

# ---- Build layer ----
COPY . ./
RUN pnpm --filter @stripe/sync-engine deploy --prod /deploy

# Final image — just the bundle + external node_modules
FROM node:24-alpine
WORKDIR /app

COPY --from=build /deploy/package.json ./
COPY --from=build /deploy/dist ./dist
COPY --from=build /deploy/node_modules ./node_modules

ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ARG COMMIT_URL=unknown
ENV NODE_ENV=production
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_DATE=$BUILD_DATE
ENV COMMIT_URL=$COMMIT_URL
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["serve"]
