# Local development setup

The API needs three datastores running locally: **PostgreSQL**, **MongoDB**, and
**Redis**. This guide installs them natively.

> These services used to be provisioned by `docker-compose.yml`, which was
> removed along with the rest of the Docker tooling when deployment moved to
> Render (a native Node build — see `hosting-guide.md`). The connection strings
> below are the same ones that file produced, with one improvement: **Postgres is
> now on the standard port 5432**. The old stack published it on 5433, which
> silently disagreed with the default in `tests/setup.ts` — anyone running the
> integration suite had to override `DATABASE_URL` or wonder why it couldn't
> connect.

## What you actually need running

The test suite is far less demanding than the dev server — only PostgreSQL has
to be up for `npm test`.

| Service | `npm run dev` | `npm test` |
|---|---|---|
| **PostgreSQL** | Yes — `fuhsox` | Yes — a separate `fuhsox_test` database |
| **MongoDB** | Yes — `fuhsox` | No. `tests/setup.ts` spins up an in-memory `MongoMemoryServer` |
| **Redis** | Yes | No. Every queue and rate-limiter path is `jest.mock()`ed |

So if you only want to run tests, do step 1 and the PostgreSQL half of step 2,
and skip the rest.

---

## 1 — Prerequisites

- Node.js ≥ 20
- PostgreSQL 16
- MongoDB 7
- Redis 7 (on Windows, use Redis via WSL2 or Memurai — there is no official
  native Windows build)

### macOS (Homebrew)

```bash
brew install postgresql@16 mongodb-community@7.0 redis
brew services start postgresql@16
brew services start mongodb-community@7.0
brew services start redis
```

### Debian / Ubuntu

```bash
sudo apt install postgresql-16 redis-server
# MongoDB needs its own apt repository — see
# https://www.mongodb.com/docs/manual/administration/install-on-linux/
sudo systemctl enable --now postgresql redis-server mongod
```

### Windows

Install the PostgreSQL and MongoDB Windows installers, then run Redis inside
WSL2 (`sudo apt install redis-server`). Ports forward to `localhost`
automatically.

---

## 2 — Create the databases and users

The app connects as a `fuhsox` role. These commands reproduce exactly what the
old compose stack created on first boot.

### PostgreSQL

**Two databases are required.** `fuhsox` is what you develop against;
`fuhsox_test` is what the test suite connects to. `tests/setup.ts` defaults
`DATABASE_URL` to `…@localhost:5432/fuhsox_test` and the suite fails at
connection time if that database does not exist. It is a separate database, not
a schema inside `fuhsox` — tests truncate freely, so they must never point at
your dev data.

```bash
sudo -u postgres psql   # on macOS/Homebrew: psql postgres
```

```sql
CREATE ROLE fuhsox WITH LOGIN PASSWORD 'fuhsox_dev_pass';
ALTER ROLE fuhsox CREATEDB;

CREATE DATABASE fuhsox      OWNER fuhsox;
CREATE DATABASE fuhsox_test OWNER fuhsox;

GRANT ALL PRIVILEGES ON DATABASE fuhsox      TO fuhsox;
GRANT ALL PRIVILEGES ON DATABASE fuhsox_test TO fuhsox;
\q
```

### MongoDB

Needed for `npm run dev` only — the test suite uses an in-memory server and never
touches your local Mongo.

The old stack ran Mongo with root credentials, which is why `MONGODB_URI` carries
`?authSource=admin`. Reproduce that:

```bash
mongosh
```

```javascript
use admin
db.createUser({
  user: 'fuhsox',
  pwd:  'fuhsox_dev_pass',
  roles: [{ role: 'root', db: 'admin' }],
})
```

Then enable auth in `mongod.conf` (`security.authorization: enabled`) and
restart. To skip auth locally instead, drop the credentials from `MONGODB_URI`:
`mongodb://localhost:27017/fuhsox`.

### Redis

Also `npm run dev` only — tests mock every path that touches Redis.

Set a password to match `REDIS_URL`. In `redis.conf`:

```
requirepass fuhsox_redis_pass
appendonly yes
```

Restart Redis. To run without a password instead, use `REDIS_URL=redis://localhost:6379`.

---

## 3 — Environment

```bash
cp .env.example .env
```

The defaults already match the setup above:

```bash
DATABASE_URL=postgresql://fuhsox:fuhsox_dev_pass@localhost:5432/fuhsox
MONGODB_URI=mongodb://fuhsox:fuhsox_dev_pass@localhost:27017/fuhsox?authSource=admin
REDIS_URL=redis://:fuhsox_redis_pass@localhost:6379
```

Fill in the rest — JWT secrets, the AI provider key, storage credentials. See
the Environment Variables table in `README.md`.

---

## 4 — Email in development

MailHog previously ran in the compose stack and caught outbound mail on
`localhost:1025`, with a web UI on `:8025`. Two replacements, both already
described in `.env.example`:

| Option | Setup | Delivers to |
|---|---|---|
| **MailHog standalone** | `brew install mailhog` / [download a release](https://github.com/mailhog/MailHog/releases), run `mailhog` | A local inbox at `http://localhost:8025`, nothing leaves your machine |
| **Brevo over HTTP** | `MAIL_PROVIDER=brevo` + `BREVO_API_KEY` | Real inboxes; also the only option that works on Render's free tier |

Keeping MailHog is the closest match to the old behaviour: `SMTP_HOST=localhost`,
`SMTP_PORT=1025`, and **both `SMTP_USER` and `SMTP_PASS` empty** — MailHog accepts
no auth and rejects a transport that offers credentials.

---

## 5 — Database schema and seed

```bash
npm run db:generate    # Prisma client from schema
npm run db:migrate     # Apply migrations
npm run db:seed        # Institution, badges, admin user, sample questions
```

---

## 6 — Run

```bash
npm run dev            # API on http://localhost:4000
npm run workers:start  # Background workers (separate terminal)
```

Health check: `http://localhost:4000/api/v1/health`

---

## Troubleshooting

**`P1001: Can't reach database server at localhost:5432`** — Postgres isn't
running, or is on 5433 from the old compose stack. Check with
`pg_isready -h localhost -p 5432`.

**`MongoServerError: Authentication failed`** — the Mongo user wasn't created in
the `admin` database, or `?authSource=admin` is missing from `MONGODB_URI`.

**`NOAUTH Authentication required`** — `requirepass` is set in Redis but the
password is missing from `REDIS_URL` (note the empty username: `redis://:pass@host`).

**Integration tests fail to connect** — `fuhsox_test` doesn't exist, or Postgres
is on the old 5433. Create the database as in step 2; it is separate from
`fuhsox`, not a schema inside it. If Mongo or Redis is down, that is *not* the
cause — tests use an in-memory Mongo and mock Redis.
