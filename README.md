# Personal AI Assistant — Multi-Tenant Telegram Executive Assistant

A multi-tenant SaaS where an **admin** onboards **clients** (busy executives), and each
client talks to their **own isolated AI executive assistant** over their **own Telegram
bot**. The assistant manages the client's **tasks** (Postgres) and **Google Calendar**
(per-client OAuth, always read live), sends **timed reminders**, and delivers a
**timezone-aware daily brief**.

**The core guarantee:** the app — not the model — owns the tool loop. Every action the
assistant claims is an action our code actually executed, every tool call is written to
an audit log, and failures are reported honestly ("that didn't go through"). A
confirmation without a real result is structurally impossible.

## Stack

| Layer | Tech |
|---|---|
| API | NestJS (strict TypeScript) — webhooks, OAuth, agent loop, tools, cron, admin API |
| Dashboard | Next.js App Router + Tailwind + shadcn/ui (admin-only) |
| Database | PostgreSQL via Prisma (existing VPS instance) |
| LLM | Anthropic Claude (`claude-opus-4-8`), app-owned manual tool loop |
| Messaging | Telegram Bot API — webhooks, one dedicated bot per client |
| Calendar | Google Calendar API — per-client OAuth2, live reads (never mirrored) |
| Tests | Jest (34 unit incl. loop-invariant proofs) + Playwright E2E |
| Deploy | Docker Compose behind Caddy (automatic TLS) on the VPS |

## Repository layout

```
apps/api          NestJS backend
  src/agent       the app-owned tool loop + system prompt
  src/tools       one file per tool (task/calendar/memory) — drop-in extensible
  src/tenancy     ClientScopedRepository — tenant isolation by construction
  src/integrations  telegram / google / anthropic
  src/jobs        reminder cron, daily brief, admin alerts
  src/admin       dashboard auth + management API
apps/web          Next.js admin dashboard
packages/shared   Shared TypeScript contracts
e2e               Playwright suite
docker            Dockerfiles, compose, Caddyfile
```

---

## 1 · Local development

Prereqs: Node ≥ 22, pnpm ≥ 10 (`corepack enable`), Docker.

```bash
pnpm install
cp .env.example .env
```

Fill `.env` (everything is validated at boot — the API refuses to start on bad config):

| Variable | What / how |
|---|---|
| `DATABASE_URL` | Postgres connection string. Local dev: run `docker run -d --name assistant-postgres --restart unless-stopped -e POSTGRES_PASSWORD=assistant_dev -e POSTGRES_DB=assistant -p 5433:5432 -v assistant_pgdata:/var/lib/postgresql/data postgres:16-alpine` then use `postgresql://postgres:assistant_dev@localhost:5433/assistant` |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` — encrypts client secrets at rest |
| `JWT_SECRET` | `openssl rand -hex 32` — signs dashboard sessions |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Your dashboard login (≥12 char password). Created automatically at first boot |
| `ANTHROPIC_API_KEY` | From console.anthropic.com — the assistant's brain |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | See §3 |
| `ADMIN_ALERT_BOT_TOKEN` / `ADMIN_ALERT_CHAT_ID` | Optional: a bot+chat where YOU receive failure alerts |

```bash
pnpm db:migrate     # create the schema
pnpm dev            # API :3001 + dashboard :3000
```

Open http://localhost:3000 → sign in with `ADMIN_EMAIL`/`ADMIN_PASSWORD`.

**Chat with the agent before Telegram is connected** (dev-only harness):

```bash
curl -X POST localhost:3001/dev/clients -H 'content-type: application/json' \
  -d '{"name":"Me","timezone":"Asia/Riyadh","assistantName":"Aya"}'
# → {"id":"<CLIENT_ID>", ...}
curl -X POST localhost:3001/dev/chat -H 'content-type: application/json' \
  -d '{"clientId":"<CLIENT_ID>","message":"add a task to buy milk tomorrow 5pm"}'
```

## 2 · Deploy to the VPS

DNS: point `assistant.yourdomain.com` (A record) at the VPS first — Caddy gets the TLS
certificate automatically.

```bash
git clone <repo> && cd personal-ai-assistant
cp .env.example .env
# Production values (no trailing slashes — CORS matches strings exactly):
#   DOMAIN=assistant.yourdomain.com
#   PUBLIC_API_URL=https://assistant.yourdomain.com/api
#   PUBLIC_WEB_URL=https://assistant.yourdomain.com
#   GOOGLE_REDIRECT_URI=https://assistant.yourdomain.com/api/google/oauth/callback
#   DATABASE_URL=postgresql://user:pass@host.docker.internal:5432/assistant
#     (host.docker.internal = Postgres running on the VPS host itself)
#   + all secrets from §1
cd docker
docker compose --env-file ../.env up -d --build
```

- The API container runs `prisma migrate deploy` on every boot — deploys apply schema
  changes automatically, and a failed migration stops the boot.
- Routing: `/{api}/*` → NestJS (webhooks, OAuth, admin API), everything else → dashboard.
- Update: `git pull && docker compose --env-file ../.env up -d --build`.
- Logs: `docker compose logs -f api`.

## 3 · Google Cloud setup (once)

In [console.cloud.google.com](https://console.cloud.google.com) with your existing project:

1. **Enable the API**: APIs & Services → Library → **Google Calendar API** → Enable.
2. **Consent screen**: External; add scope `https://www.googleapis.com/auth/calendar`.
   While in "Testing" mode add each client's Gmail as a test user, or publish the app.
3. **OAuth client** (type: Web application): add the redirect URI
   `https://assistant.yourdomain.com/api/google/oauth/callback` — must equal
   `GOOGLE_REDIRECT_URI` exactly.
4. Put the client ID/secret in `.env`.

## 4 · Onboarding a client (runbook)

1. **Create the bot**: in Telegram, talk to **@BotFather** → `/newbot` → name it (e.g.
   "Sarah's Assistant") → copy the token.
2. **Dashboard → New client**: name, IANA timezone (e.g. `Asia/Riyadh`), assistant name.
3. **Client page → Setup → Telegram**: paste the bot token → Connect. The token is
   validated, encrypted, and the webhook (with a fresh secret) registered automatically.
4. **Setup → Google Calendar → Generate connection link** → send the link to the client.
   They sign in with their Google account and approve calendar access (15-min link;
   no password ever touches this system).
5. Tell the client to open their bot and say hi. The **first private chat binds** to
   the client; all other chats are refused.
6. Watch the **Audit log** tab — every tool call (input, result, success) appears there.

**Disable a client** (Setup → status): webhooks are rejected and jobs skip them
immediately; history and audit log are kept. Deleting audit history is deliberately
impossible while the client exists (database-level RESTRICT).

## 5 · What clients can do

Tasks: create / list ("what's on my plate this week?") / update / complete / delete,
reminders ("remind me Thursday 4pm") delivered by the bot.
Calendar: read ("what do I have today?" — includes events added directly in the Google
Calendar app), create / move / delete meetings with automatic **conflict checking**
(double-booking requires their explicit confirmation).
Memory: durable preferences ("I prefer 30-minute meetings") via `save_memory`.
Daily brief: every morning at their configured hour, live calendar + overdue + today's
tasks.

The calendar is kept clean by policy: **only meetings and genuinely time-blocked events
go on it** — ordinary to-dos stay in the task list.

## 6 · Reliability model (what makes it trustworthy)

1. **App-owned tool loop** — Claude requests a tool; OUR code validates the input (zod),
   executes it against tenant-scoped data, writes the audit row, and feeds the real
   result back. The reply is grounded only in real results.
2. **Tenant isolation by construction** — tools receive a `ClientScopedRepository`
   bound to one clientId; cross-tenant access is impossible to express.
3. **Honest failure everywhere** — tool errors → `is_error` result + "didn't go
   through" reply; Google grant revoked → client flagged "needs re-auth" (red badge);
   Telegram/API failures retried with backoff, then surfaced; the health check returns
   503 when the DB is down, never a fake 200.
4. **Exactly-once side effects** — webhook dedup via `(clientId, update_id)` unique
   constraint; reminders/briefs claim atomically before sending and revert on failure.
5. **Admin alerting** — job failures and per-client delivery problems are pushed to
   your Telegram (throttled to one per issue per hour).
6. **Bounded everything** — windowed task queries with row caps, last-N context,
   cursor-paginated audit, tool-iteration ceiling, rate limits (5 login attempts/min),
   256 KB body cap.

## 7 · Scripts & testing

| Command | What |
|---|---|
| `pnpm dev` / `pnpm build` | Run / build both apps |
| `pnpm typecheck` / `pnpm lint` | Strict TS + ESLint everywhere |
| `pnpm test` | Unit tests (loop invariants, conflict gating, dedup, crypto, jobs) |
| `pnpm e2e` | Playwright vs the running stack (first: `pnpm --filter @assistant/e2e exec playwright install chromium`) |
| `pnpm db:migrate` / `pnpm db:studio` | Apply migrations / browse DB |

## 8 · Extending (new tools)

Add a file in `apps/api/src/tools/` exporting a `defineTool({name, description,
schema, execute})`, register it in `tools/index.ts` (append — order is part of the
prompt cache), and it's live: schema generation, validation, audit logging, and the
dashboard audit view all pick it up automatically. `send_email` later = one file.

## Known limits (v1, by design)

- Per-client message serialization is in-process — correct for the single API
  container; scale-out to multiple API instances needs a shared queue (BullMQ).
- Telegram: text messages only (voice/photos get a polite "text only" reply).
- Calendar: the client's primary Google calendar.
- Deleting a client with audit history is blocked (disable instead) until an explicit
  archival flow exists.
