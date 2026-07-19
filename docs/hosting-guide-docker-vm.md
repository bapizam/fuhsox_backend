# FuhsoX Backend — Hosting Guide (single VM + Docker Compose)

> **Status: the "later / launch" path.** The active guide is `hosting-guide.md`
> (Render, no card, for the testing phase). Use THIS one when you want an
> always-on box — a paid VPS, or Oracle Cloud once you're card-verified. The
> Dockerfile + `docker-compose.prod.yml` here work on ANY VPS, not just Oracle.

Goal: a stable `https://…` URL the mobile app reaches from anywhere, replacing the
LAN IP. This is the **self-hosted, always-on** path — the whole stack (API +
Postgres + Mongo + Redis + Caddy TLS) as containers on one VM.

Written 2026-07-19. Provider free-tier terms change — verify Oracle's current
Always Free limits before relying on them.

---

## What the agent already created (in `application/backend/`)

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build of the API image (compiles TS, bundles Prisma client + the `email-templates/` the app loads at runtime). |
| `docker-entrypoint.sh` | Runs `prisma migrate deploy`, then starts the server as PID 1. |
| `docker-compose.prod.yml` | API + Postgres + Mongo + Redis + Caddy, private network, only Caddy exposed. |
| `Caddyfile` | Automatic HTTPS (Let's Encrypt) + reverse proxy, WebSocket-transparent. |
| `.env.production.example` | Every env var, with the connection strings handled for you. |
| `.dockerignore` | Keeps `node_modules`, secrets, tests out of the image. |

You mostly **fill in `.env` and run three commands**. The rest is provisioning.

---

## The shape of it

`src/index.ts` is one process = API + Socket.io + both BullMQ workers + three cron
schedulers. The compose file runs that as the `api` service, with its datastores
as sibling containers and Caddy terminating HTTPS in front.

### Boot-blockers — the server exits on startup without these
`src/config/env.ts` marks them required: the JWT secrets, the Google web client
(`GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`), `ANTHROPIC_API_KEY` (must start
`sk-ant-`), the full `AWS_*` block, and `FRONTEND_URL`. The datastore URLs are
derived by compose. A boot crash almost always names the missing var in the logs.

### Two things that silently break sign-in
1. **Seed an institution** (Phase 6) — OTP signup rejects any email whose domain
   isn't registered (`DOMAIN_NOT_ALLOWED`).
2. **AWS SES sandbox** only emails **verified** addresses. Until you request SES
   production access, OTP codes reach only emails you verified in the SES console.
   OTP is the primary login — this is the usual "code never arrived" cause.

---

## Phase 1 — Create the Oracle VM

1. cloud.oracle.com → sign up (needs a card for identity; Always Free isn't charged).
2. Compute → Instances → **Create Instance**.
   - **Shape:** change to **Ampere (Arm)** → `VM.Standard.A1.Flex`. Always Free
     allows up to 4 OCPU / 24 GB RAM — 2 OCPU / 12 GB is plenty and leaves headroom.
   - **Image:** Ubuntu 22.04 (or 24.04).
   - **SSH keys:** upload/download a key pair — you need it to log in.
3. After it boots, note the **public IPv4 address**.
4. **Networking → open the firewall** (two layers on Oracle):
   - VCN **Security List / NSG**: add ingress rules for **TCP 80** and **TCP 443**
     from `0.0.0.0/0`.
   - On the box, allow them in the host firewall too:
     ```bash
     sudo iptables -I INPUT -p tcp --dport 80  -j ACCEPT
     sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
     sudo netfilter-persistent save
     ```
   (Oracle Ubuntu images ship with restrictive iptables — skipping this is the #1
   "Caddy can't get a certificate / site unreachable" cause.)

## Phase 2 — A domain that points at the VM (needed for HTTPS)

Let's Encrypt won't issue a cert for a raw IP, and release Android builds block
plain-HTTP anyway — so you need a hostname.

- Free option: **duckdns.org** → sign in → create a subdomain → set its IP to the
  VM's public IPv4. You get e.g. `fuhsox.duckdns.org`.
- Confirm it resolves before continuing: `ping fuhsox.duckdns.org` shows the VM IP.

## Phase 3 — Install Docker on the VM

```bash
ssh -i <your-key> ubuntu@<vm-ip>

curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker            # or log out/in so the group applies
docker --version         # sanity check
```

## Phase 4 — Get the code onto the VM

```bash
# On the VM. Use HTTPS clone, or a read-only deploy key for a private repo.
git clone <your-repo-url> fuhsox
cd fuhsox/application/backend
```

## Phase 5 — Configure and launch

```bash
cp .env.production.example .env
nano .env                 # fill EVERY value — see the checklist below
```

`.env` checklist:
- `DOMAIN` = your duckdns hostname (no `https://`)
- `POSTGRES_PASSWORD` / `MONGO_PASSWORD` / `REDIS_PASSWORD` = long random strings
- `FRONTEND_URL` = `https://<DOMAIN>`
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` = `openssl rand -hex 32` each
- `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`, `GOOGLE_ANDROID_CLIENT_ID`
- `ANTHROPIC_API_KEY` (`sk-ant-…`), the `AWS_*` block, `AWS_SES_FROM_EMAIL`

Launch (builds the image on the ARM box, so the Prisma engine is the right arch):

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f api    # watch for "✅ FuhsoX API listening"
```

The entrypoint runs `prisma migrate deploy` automatically before the server starts,
so the Postgres schema is created on first boot. Caddy fetches the TLS cert within
a minute (watch `logs -f caddy` if the site isn't HTTPS yet).

## Phase 6 — Seed (one-time)

Migrations ran automatically; seeding is deliberately manual. The Dockerfile
compiles the seed to plain JS (the runtime image has no `ts-node`), so run it once
inside the running api container:

```bash
docker compose -f docker-compose.prod.yml exec api node dist/prisma/seed.js
```

Check which institution email domains it registers, then sign up with a matching
address.

## Phase 7 — Verify

```bash
curl https://<DOMAIN>/api/v1/health      # → {"success":true,...}
```

If that returns success over HTTPS, the backend is live and public.

## Phase 8 — Point the app at it

- **eas.json** `base.env.EXPO_PUBLIC_API_URL` → `https://<DOMAIN>/api/v1`
  (production/preview bundles embed this).
- **Dev build** — optionally set the same in frontend `.env` and restart Metro to
  test against prod; or keep it on LAN for speed.
- Rebuild whichever profile's bundle you changed.

Also add the deployed origins in Google Cloud Console if you use web Google later;
the mobile id_token flow doesn't need it.

---

## Day-2 operations

```bash
# Redeploy after a git pull
git pull && docker compose -f docker-compose.prod.yml up -d --build

# Logs / status
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f api

# Apply a new migration you committed (entrypoint also does this on restart)
docker compose -f docker-compose.prod.yml exec api npx prisma migrate deploy

# Back up Postgres (do this before migrations / regularly)
docker compose -f docker-compose.prod.yml exec postgres \
  pg_dump -U fuhsox fuhsox > backup-$(date +%F).sql
```

### Trade-offs vs the managed path
- **Always-on** — cron reminders and workers run 24/7 (the whole point vs a
  free PaaS that sleeps).
- **You own the box** — OS updates, disk, backups, and cert renewal (Caddy
  auto-renews, but the VM must stay up) are yours. Take Postgres/Mongo backups.
- **ARM images** — everything here (node, postgres, mongo, redis, caddy) has
  arm64 images, so this is fine; just know third-party images occasionally don't.
- Oracle **reclaims idle Always Free instances** in some regions — keep it in use,
  and don't rely on it for anything you can't rebuild from this repo + backups.

## If you outgrow the free VM
Move the datastores to managed services (Neon Postgres, Atlas Mongo) and keep just
the API container here, or lift the same compose onto a paid VM. The Dockerfile and
compose don't change — only the connection strings in `.env`.
