#!/bin/sh
# Applies any pending migrations, then hands off (exec) to the Node server so it
# becomes PID 1 and receives SIGTERM for the app's graceful shutdown.
#
# `migrate deploy` is idempotent — safe to run on every boot. It only APPLIES
# committed migrations; it never generates or resets. Seeding is a separate,
# one-time manual step (see docs/hosting-guide.md), deliberately NOT run here.
set -e

echo "→ Applying database migrations (prisma migrate deploy)…"
npx prisma migrate deploy

echo "→ Starting FuhsoX API…"
exec node dist/src/index.js
