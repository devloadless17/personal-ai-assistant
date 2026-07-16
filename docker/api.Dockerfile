# NestJS API — multi-stage build for a small, production-only image.
# Build context is the REPO ROOT: docker build -f docker/api.Dockerfile .

FROM node:22-alpine AS base
# Install pnpm once in the shared base layer (npm has robust retries;
# corepack re-downloads pnpm per stage and dies on flaky networks).
RUN npm install -g pnpm@11.9.0
# Shared pnpm store via BuildKit cache mount: fast rebuilds, and bounded
# network concurrency + retries make installs reliable on flaky networks.
ENV npm_config_store_dir=/pnpm/store \
    npm_config_network_concurrency=8 \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_maxtimeout=120000
WORKDIR /app

# ── build: full install, generate Prisma client, compile ─────────────────────
FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
# Retry loop: @prisma/engines' postinstall downloads binaries with limited
# internal retries; on flaky networks the whole install must be re-attempted.
# The pnpm store cache makes retries cost seconds, not minutes.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=prisma-engines,target=/root/.cache/prisma \
    for i in 1 2 3 4 5; do \
      pnpm install --frozen-lockfile --filter @assistant/api... --filter @assistant/shared && exit 0; \
      echo "install attempt $i failed, retrying in 5s..."; sleep 5; \
    done; exit 1
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN --mount=type=cache,id=prisma-engines,target=/root/.cache/prisma \
    pnpm --filter @assistant/api exec prisma generate \
 && pnpm --filter @assistant/api build

# ── runtime: prod deps + dist only, non-root ─────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=prisma-engines,target=/root/.cache/prisma \
    for i in 1 2 3 4 5; do \
      pnpm install --frozen-lockfile --prod --filter @assistant/api... --filter @assistant/shared && exit 0; \
      echo "install attempt $i failed, retrying in 5s..."; sleep 5; \
    done; exit 1
COPY --from=build --chown=node:node /app/apps/api/dist apps/api/dist
COPY --chown=node:node apps/api/prisma apps/api/prisma
# prisma CLI is a prod dependency: regenerate the client against this stage's
# node_modules, and let the entrypoint apply migrations on every boot.
# node_modules stays root-owned (read-only to the runtime user) — hardening.
RUN --mount=type=cache,id=prisma-engines,target=/root/.cache/prisma \
    pnpm --filter @assistant/api exec prisma generate

USER node
WORKDIR /app/apps/api
EXPOSE 3001
# Apply pending migrations, then exec node so it becomes PID-1-adjacent and
# receives SIGTERM directly — NestJS shutdown hooks + Prisma disconnect run
# on every `docker stop`/redeploy. A failed migration stops the boot — the
# container never runs against a schema it doesn't expect.
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && exec node dist/main.js"]
