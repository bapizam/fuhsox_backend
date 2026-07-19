# FuhsoX Backend — Hosting Guide (Render, no card)

Goal: a stable `https://…` URL the mobile app reaches from anywhere, replacing the
LAN IP — with **no credit card** anywhere and everything on free tiers.

Written 2026-07-19. Free-tier terms change — verify each provider's current limits.
For an always-on box later (paid VPS or Oracle), see `hosting-guide-docker-vm.md`;
the Docker files in this folder deploy there unchanged.

---

## The shape of it

`src/index.ts` is one process = API + Socket.io + both BullMQ workers + three cron
schedulers. You deploy that once on Render, backed by three managed datastores:

| Piece | Host | Card? |
|---|---|---|
| Node web service | **Render** (buildpack, native WebSocket, fixed URL) | No |
| PostgreSQL | **Neon** | No |
| MongoDB | **Atlas M0** | No |
| Redis | **Render Key Value** | No |
| S3 + SES | your existing **AWS** | — |

### Boot-blockers — the server exits on startup without these
`src/config/env.ts` requires: the JWT secrets, `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`,
`ANTHROPIC_API_KEY` (must start `sk-ant-`), the full `AWS_*` block, `FRONTEND_URL`,
and the three datastore URLs. A boot crash names the missing var in the logs.

### Two things that silently break sign-in
1. **Seed an institution** (Phase 4) or OTP signup fails `DOMAIN_NOT_ALLOWED`.
2. **AWS SES sandbox** only emails **verified** addresses. Until you request SES
   production access, OTP codes reach only emails you verified in the SES console.
   OTP is the primary login — the usual "code never arrived" cause.

---

## Phase 1 — Databases (do first; they hand you connection strings)

### 1a. PostgreSQL → Neon
1. neon.tech → sign up with GitHub (no card) → **New Project**, pick a region.
2. Copy the **pooled** connection string
   (`postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/dbname?sslmode=require`).
   That's your `DATABASE_URL`.

### 1b. MongoDB → Atlas
1. mongodb.com/atlas → sign up (no card) → build an **M0 (free)** cluster.
2. Database Access → add a user (username + password).
3. Network Access → allow `0.0.0.0/0` (Render's egress IPs aren't fixed on free).
4. Connect → Drivers → copy the URI, insert the db name (`/fuhsox`) before the `?`:
   `mongodb+srv://user:pass@cluster.mongodb.net/fuhsox?retryWrites=true&w=majority`.
   That's your `MONGODB_URI`.

---

## Phase 2 — Deploy the API on Render

### 2a. Create the Web Service
1. render.com → sign up with GitHub (no card for free) → New → **Web Service**.
2. Connect the repo → **Root Directory:** `application/backend`.
3. **Runtime:** Node · **Instance type:** Free.
4. **Build Command** — note `--include=dev`: with `NODE_ENV=production` set, plain
   `npm ci` would skip TypeScript/Prisma CLI and the build would fail:
   ```
   npm ci --include=dev && npx prisma generate && npm run build
   ```
5. **Start Command:**
   ```
   npm run start
   ```
6. **Health Check Path:** `/api/v1/health`

### 2b. Add Redis
Render dashboard → New → **Key Value** (free) → copy its **Internal** URL → that's
`REDIS_URL`. (Internal = same-region, no egress cost; memory-metered, so BullMQ's
constant polling won't burn a request quota the way command-metered tiers do.)

### 2c. Environment variables (service → Environment)
Add every var from `.env.example`. Specifics for this deployment:
- `NODE_ENV=production`
- **Leave `PORT` unset** — Render injects its own `PORT` and the app binds it.
- `FRONTEND_URL=https://<your-service>.onrender.com` (must be a valid URL for env
  validation; only feeds CORS/Socket.io — the mobile app doesn't rely on it)
- `GOOGLE_REDIRECT_URI=https://<your-service>.onrender.com/api/v1/auth/google`
  (required to be a URL; unused by the mobile id_token flow)
- `DATABASE_URL`, `MONGODB_URI` (Phase 1), `REDIS_URL` (Phase 2b)
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — `openssl rand -hex 32` each
- `GOOGLE_CLIENT_ID/SECRET`, `GOOGLE_ANDROID_CLIENT_ID`
- `ANTHROPIC_API_KEY` (`sk-ant-…`), the `AWS_*` block, `AWS_SES_FROM_EMAIL`
- **Do NOT set** `SMTP_*` — those are the local MailHog dev fallback.

### 2d. First deploy
Render builds + starts. Watch the logs for `✅ FuhsoX API listening`. A boot crash
is almost always a missing required env var (named in the log).

---

## Phase 3 — Migrate the schema (one-time)

Unlike a private VM, Neon is internet-reachable, so run this from **your machine**
pointed at the cloud DB (ts-node is a local dev dep, so `db:seed` works here too).

**Windows/PowerShell** — the inline `VAR=x cmd` form is bash-only; set the vars
first (they last for the terminal session):
```powershell
cd application/backend
$env:DATABASE_URL="<neon-pooled-url>"
npx prisma migrate deploy
```
(bash / Git Bash equivalent: `DATABASE_URL="<neon-pooled-url>" npx prisma migrate deploy`)

Applies all migrations incl. `20260718120000_ai_budget_20`.

## Phase 4 — Seed an institution (one-time)

```powershell
$env:DATABASE_URL="<neon-pooled-url>"
$env:MONGODB_URI="<atlas-uri>"
npm run db:seed
```

Check which email domains the seed registers, then sign up with a matching address.

## Phase 5 — Verify

```bash
curl https://<your-service>.onrender.com/api/v1/health    # → {"success":true,...}
```

## Phase 6 — Point the app at it

- **eas.json** `base.env.EXPO_PUBLIC_API_URL` → `https://<service>.onrender.com/api/v1`
  (production/preview bundles embed this).
- **Dev build** — optionally set the same in frontend `.env` + restart Metro to test
  against prod; or keep it on LAN for speed.
- Rebuild whichever profile's bundle you changed.

---

## The one trade-off to know

Render's **free web service sleeps after ~15 min idle**. The first request after
sleep cold-starts (~30–60 s), and **while asleep the cron schedulers and workers
don't run** — study reminders won't fire on time. Perfectly fine for testing.

When you go live, either upgrade the Render instance to always-on (~$7/mo), or move
to the always-on Docker VM path (`hosting-guide-docker-vm.md`) — same app, the
Dockerfile/compose in this folder are ready. Keep-alive pingers violate most
free-tier ToS, so don't rely on them.
