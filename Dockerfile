# ─── Build stage ──────────────────────────────────────────────────────────────
# Debian slim (glibc) rather than Alpine (musl): Prisma's engines are simpler on
# glibc, and we build ON the target VM (arm64), so the "native" engine is correct.
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Install against the lockfile — dev deps included (tsc, tsc-alias, prisma need them).
COPY package.json package-lock.json ./
RUN npm ci

# Generate the Prisma client, then compile TS → dist/ (tsc + tsc-alias).
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build
# The app build (tsconfig.build) intentionally excludes prisma/, but we want the
# seed runnable in the prod image with plain `node` (no ts-node there). It imports
# only @prisma/client + bcryptjs, so a standalone compile → dist/prisma/seed.js.
RUN npx tsc prisma/seed.ts --outDir dist/prisma \
      --module commonjs --moduleResolution node \
      --esModuleInterop --skipLibCheck --target es2022

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Prisma's query engine needs openssl at runtime; ca-certificates for TLS out to
# SES / Mongo / Anthropic.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Production deps only. "prisma" and "@prisma/client" live in dependencies (not
# devDependencies), so `prisma migrate deploy` still works from this image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Regenerate the client against the prod node_modules, on this platform.
COPY prisma ./prisma
RUN npx prisma generate

# Compiled app, plus the runtime asset tsc does NOT emit:
#   email-templates/*.hbs → email.service.ts loads these from process.cwd().
#   Forgetting this dir builds fine and crashes on the first OTP email.
COPY --from=builder /app/dist ./dist
COPY email-templates ./email-templates
COPY docker-entrypoint.sh ./docker-entrypoint.sh
# Strip any CRLF (this repo is developed on Windows) so /bin/sh doesn't choke on
# a `\r` in the shebang, then make it executable.
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

EXPOSE 4000

# Liveness against the app's own public health route. No curl in slim → use node.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:4000/api/v1/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Runs `prisma migrate deploy` then starts the server (see docker-entrypoint.sh).
ENTRYPOINT ["./docker-entrypoint.sh"]
