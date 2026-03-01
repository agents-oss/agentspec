# Build context must be the repo root:
#   docker build -f packages/sidecar/Dockerfile .
# or via docker-compose (context: ../../  build.dockerfile: packages/sidecar/Dockerfile)

FROM node:22-alpine AS builder
WORKDIR /repo

# Enable pnpm via corepack
RUN corepack enable

# Copy workspace metadata first (layer cache)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/sidecar/package.json ./packages/sidecar/package.json
COPY packages/sidecar/tsup.config.ts ./packages/sidecar/tsup.config.ts

# Install all deps (workspace links resolved by pnpm)
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/sdk ./packages/sdk
COPY packages/sidecar/src ./packages/sidecar/src
COPY packages/sidecar/tsconfig.json ./packages/sidecar/tsconfig.json

# Build SDK first, then sidecar (tsup bundles @agentspec/sdk into dist/index.js)
RUN pnpm --filter @agentspec/sdk build
RUN pnpm --filter @agentspec/sidecar build

# ── Production image ──────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

# Copy only the bundled output + runtime node_modules (sdk is inlined by tsup)
COPY --from=builder /repo/packages/sidecar/dist ./dist
COPY --from=builder /repo/packages/sidecar/package.json ./package.json

# Install only production runtime deps (fastify, @fastify/http-proxy, etc.)
# @agentspec/sdk is bundled into dist/index.js — skip it
RUN npm pkg delete dependencies['@agentspec/sdk'] && \
    npm install --omit=dev --ignore-scripts

EXPOSE 4000 4001
CMD ["node", "dist/index.js"]
