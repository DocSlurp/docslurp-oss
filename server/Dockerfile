# Self-host API server image (compose.selfhost.yml). Build context: the repository root.
#   docker build -f server/Dockerfile .
# Runs the Hono API (server/src/main.ts) and, for the compose `migrate` service,
# `node server/db/migrate.mjs`. No dashboard: the frontend is not part of this image.
FROM node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip \
    NODE_ENV=production
WORKDIR /app
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY LICENSES ./LICENSES
COPY scripts/configure-debian-build-snapshot.sh /tmp/configure-debian-build-snapshot.sh
RUN sh /tmp/configure-debian-build-snapshot.sh && rm /tmp/configure-debian-build-snapshot.sh \
 && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y && apt-get install -y --no-install-recommends ca-certificates poppler-data poppler-utils && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json drizzle.config.ts ./
COPY patches ./patches
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/sdk/package.json ./packages/sdk/
COPY server/package.json ./server/
# server declares @docslurp/worker only as a test dependency; its manifest is needed to resolve the project.
COPY worker/package.json ./worker/
# Root (what the migration runner needs) plus the server and its project dependencies; the worker's own
# dependencies are not installed.
RUN NODE_ENV=development pnpm install --frozen-lockfile --filter docslurp --filter '@docslurp/server...' --filter '!@docslurp/worker'
COPY packages/shared ./packages/shared
COPY packages/sdk ./packages/sdk
COPY server ./server
RUN pnpm --filter @docslurp/shared build && pnpm --filter @docslurp/sdk build
ENV PORT=8787
EXPOSE 8787
USER node
# Run from server/ like `pnpm --filter @docslurp/server start`, without pnpm/corepack at runtime.
CMD ["sh", "-c", "cd server && exec node_modules/.bin/tsx src/main.ts"]
