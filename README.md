# Personal AI Assistant — Multi-Tenant Telegram Executive Assistant

A multi-tenant SaaS where an **admin** onboards **clients** (busy executives), and each
client talks to their **own isolated AI executive assistant** over their **own Telegram
bot**. The assistant manages the client's **tasks** (Postgres) and **Google Calendar**
(per-client OAuth, always read live).

**The core guarantee:** the app — not the model — owns the tool loop. Every action the
assistant claims is an action our code actually executed, and every tool call is written
to an audit log. A confirmation without a real result is structurally impossible.

## Stack

| Layer | Tech |
|---|---|
| API | NestJS (TypeScript, strict) — webhooks, OAuth, agent loop, tools, cron |
| Dashboard | Next.js App Router + Tailwind CSS + shadcn/ui (admin-only) |
| Database | PostgreSQL (existing VPS instance) via Prisma |
| LLM | Anthropic Claude (`claude-opus-4-8`), app-owned manual tool loop |
| Messaging | Telegram Bot API (webhooks; one dedicated bot per client) |
| Calendar | Google Calendar API (per-client OAuth2, live reads — never mirrored) |
| E2E tests | Playwright (`e2e/`) + Jest unit tests per app |
| Deploy | Docker Compose on the VPS behind Caddy (automatic TLS) |

## Repository layout

```
apps/api          NestJS backend
apps/web          Next.js admin dashboard
packages/shared   Shared TypeScript types/DTOs
e2e               Playwright end-to-end suite
docker            Dockerfiles, docker-compose.yml, Caddyfile
```

## Prerequisites

- Node.js ≥ 22, pnpm ≥ 10 (`corepack enable`)
- Docker + Docker Compose (for deployment)
- A reachable PostgreSQL database (your VPS instance)

## Setup

```bash
# 1. Install
pnpm install

# 2. Configure environment
cp .env.example .env
#    - DATABASE_URL   → your VPS Postgres connection string
#    - ENCRYPTION_KEY → openssl rand -hex 32
#    - JWT_SECRET     → openssl rand -hex 32
#    (Anthropic/Google/alert keys are needed from Milestones 2/4/5)

# 3. Create the schema (runs Prisma migrations)
pnpm --filter @assistant/api db:migrate:dev   # dev (creates migration history)
# or, against an already-migrated environment:
pnpm db:migrate                               # prisma migrate deploy

# 4. Run in development
pnpm dev            # API on :3001, dashboard on :3000
```

Verify: `curl http://localhost:3001/health` → `{"status":"ok","db":"up",...}` and
http://localhost:3000 shows “API & database up”.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | API + dashboard in watch mode |
| `pnpm build` | Build all packages |
| `pnpm typecheck` / `pnpm lint` | Strict TS + ESLint across the repo |
| `pnpm test` | Jest unit tests |
| `pnpm e2e` | Playwright end-to-end suite (stack must be running; first run: `pnpm --filter @assistant/e2e exec playwright install chromium`) |
| `pnpm db:migrate` | Apply Prisma migrations (`migrate deploy`) |
| `pnpm db:studio` | Prisma Studio DB browser |

## Deployment (VPS)

The whole stack ships as Docker Compose behind Caddy with automatic HTTPS. Postgres is
**not** containerized here — the API connects to your existing VPS Postgres.

```bash
# On the VPS, with DNS for $DOMAIN pointing at the machine:
cp .env.example .env
# Set for production (exact values matter — CORS matches PUBLIC_WEB_URL as a string):
#   DOMAIN=assistant.example.com
#   PUBLIC_API_URL=https://assistant.example.com/api    (no trailing slash)
#   PUBLIC_WEB_URL=https://assistant.example.com        (no trailing slash)
# ...plus DATABASE_URL, ENCRYPTION_KEY, JWT_SECRET and the milestone keys.
cd docker
docker compose --env-file ../.env up -d --build
```

- Caddy terminates TLS and routes `/{api}/*` → NestJS, everything else → dashboard.
- The API container runs `prisma migrate deploy` on every boot — a failed migration
  stops the boot rather than running against an unexpected schema.
- If Postgres runs on the VPS host itself, use
  `postgresql://user:pass@host.docker.internal:5432/assistant` as `DATABASE_URL`.

## Environment variables

See [.env.example](.env.example) — every variable is documented there and validated at
API boot (the app refuses to start on missing/malformed config).

## Onboarding a client (from Milestone 6)

1. Dashboard → “New client”: name, timezone, assistant name.
2. Create a Telegram bot for the client via @BotFather, paste its token — the app sets
   the webhook (with a per-client secret token) automatically.
3. Click “Connect Google Calendar” → the client authorizes their Google account.
4. The client messages their bot; the assistant is live. All actions appear in the
   client's audit log.

## Roadmap

1. ✅ **Scaffold** — monorepo, schema, health round-trip, Docker, docs
2. **Agent core** — app-owned Claude tool loop + audit log + task tools + test harness
3. **Telegram** — per-client webhook → agent → reply round trip
4. **Google Calendar** — per-client OAuth + calendar tools + conflict checking
5. **Background jobs** — reminder checker + timezone-aware daily brief
6. **Admin dashboard** — client CRUD, connections, usage + audit log
7. **Harden & document** — encryption, webhook verification, deploy hardening
