# Next.js admin dashboard — multi-stage build (standalone output).
# Build context is the REPO ROOT: docker build -f docker/web.Dockerfile .

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

# ── build ─────────────────────────────────────────────────────────────────────
FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @assistant/web... --filter @assistant/shared
COPY packages/shared packages/shared
COPY apps/web apps/web
# API_URL is read at request time (server components), not baked at build.
RUN pnpm --filter @assistant/web build

# ── runtime: Next standalone output, non-root ────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public apps/web/public

USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
