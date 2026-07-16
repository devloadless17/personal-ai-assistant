# NestJS API — multi-stage build for a small, production-only image.
# Build context is the REPO ROOT: docker build -f docker/api.Dockerfile .

FROM node:22-alpine AS base
RUN corepack enable pnpm
WORKDIR /app

# ── build: full install, generate Prisma client, compile ─────────────────────
FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @assistant/api... --filter @assistant/shared
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @assistant/api exec prisma generate \
 && pnpm --filter @assistant/api build

# ── runtime: prod deps + dist only, non-root ─────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter @assistant/api... --filter @assistant/shared
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/prisma apps/api/prisma
# prisma CLI is a prod dependency: regenerate the client against this stage's
# node_modules, and let the entrypoint apply migrations on every boot.
RUN pnpm --filter @assistant/api exec prisma generate \
 && chown -R node:node /app

USER node
WORKDIR /app/apps/api
EXPOSE 3001
# Apply pending migrations, then start. A failed migration stops the boot —
# the container never runs against a schema it doesn't expect.
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/main.js"]
