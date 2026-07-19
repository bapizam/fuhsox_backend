# FuhsoX Backend API

Production backend for **FuhsoX** — an intelligent exam-preparation and academic-engagement platform for Nigerian university health-science students (Federal University of Health Sciences, Otukpo — FUHSO).

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Database Setup](#database-setup)
- [Running the Server](#running-the-server)
- [Running Workers Separately](#running-workers-separately)
- [API Reference](#api-reference)
- [Real-Time Events (Socket.io)](#real-time-events-socketio)
- [Background Jobs & Cron Schedulers](#background-jobs--cron-schedulers)
- [Multi-Tenancy](#multi-tenancy)
- [Authentication Flow](#authentication-flow)
- [Gamification System](#gamification-system)
- [AI Features](#ai-features)
- [Email System](#email-system)
- [Testing](#testing)
- [Deployment](#deployment)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     Client (Frontend)                    │
└──────────────────────────┬──────────────────────────────┘
                           │ HTTP / WebSocket
┌──────────────────────────▼──────────────────────────────┐
│                   Express.js API Server                  │
│  ┌──────────────────┐  ┌────────────────────────────┐   │
│  │   REST Routes    │  │   Socket.io (Real-time)    │   │
│  │  /api/v1/...     │  │   Messages, Notifications  │   │
│  └────────┬─────────┘  └─────────────┬──────────────┘   │
│           │                          │                   │
│  ┌────────▼──────────────────────────▼──────────────┐   │
│  │              Service Layer                        │   │
│  │  Auth │ Quiz │ AI │ Feed │ Gamification │ Admin   │   │
│  └────────┬────────────────────────────────────────-┘   │
│           │                                              │
│  ┌────────▼──────────────────────────────────────────┐  │
│  │             Data Layer                             │  │
│  │  PostgreSQL (Prisma)  │  MongoDB (Mongoose)        │  │
│  └───────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│              Background Infrastructure                   │
│  BullMQ Workers │ Redis │ Cron Jobs │ AWS S3 │ AWS SES  │
└─────────────────────────────────────────────────────────┘
```

### Data Store Responsibilities

| Store | Used For |
|---|---|
| **PostgreSQL** (via Prisma) | Users, institutions, questions, sessions, events, news, gamification, notifications, schedules |
| **MongoDB** (via Mongoose) | Posts, comments, DMs, AI feedback documents, AI-generated questions, study plans |
| **Redis** | JWT refresh token lookups, rate limiting counters, AI daily quotas, leaderboard cache, analytics cache, cron cooldowns |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 + TypeScript 5.5 (strict mode) |
| HTTP Framework | Express.js 4.x |
| ORM — PostgreSQL | Prisma 5.x |
| ODM — MongoDB | Mongoose 8.x |
| Real-time | Socket.io 4.x |
| Cache / Queues | Redis 7 + BullMQ 5 |
| AI | Anthropic Claude API (claude-opus-4-6) |
| Email | AWS SES (production) / Nodemailer+MailHog (dev) |
| File Storage | AWS S3 |
| Authentication | Email OTP + Google OAuth 2.0 + JWT (short-lived access + HttpOnly refresh) |
| Validation | Zod |
| Logging | Pino (structured JSON) |
| Error Tracking | Sentry v8 |
| Testing | Jest + Supertest + MongoMemoryServer |

---

## Project Structure

```
fuhsox-backend/
├── email-templates/          # Handlebars (.hbs) email templates
├── mongo/
│   └── schemas/              # Mongoose model definitions
├── prisma/
│   ├── schema.prisma         # Full Prisma schema (PostgreSQL)
│   └── seed.ts               # Database seeder
├── src/
│   ├── app.ts                # Express app factory
│   ├── index.ts              # Entry point — boot server + workers + crons
│   ├── config/               # env, database, redis, constants
│   ├── controllers/          # Request handlers (auth, student, admin)
│   ├── jobs/
│   │   ├── queues.ts         # BullMQ queue definitions
│   │   ├── workers/          # Email worker, PDF worker
│   │   └── schedulers/       # Study reminder cron, risk-flag cron, scheduled-content cron
│   ├── lib/                  # Singleton clients (Anthropic, S3, OTP utils, Redis helpers)
│   ├── middleware/           # Auth, RBAC, rate limiting, validation, error handler
│   ├── routes/               # Express router definitions
│   ├── services/             # Business logic
│   │   └── admin/            # Admin-only services (analytics, broadcast, events, news)
│   ├── socket/               # Socket.io server + event handlers
│   ├── types/                # TypeScript type definitions and augmentations
│   └── utils/                # Pagination, response helpers, XP calculations
└── tests/
    ├── setup.ts              # Jest global setup (MongoDB in-memory, env vars)
    ├── unit/                 # Unit tests (XP math, OTP hashing, streak logic)
    └── integration/          # Supertest integration tests (all route groups)
```

---

## Getting Started

### Prerequisites

- Node.js ≥ 20
- Docker + Docker Compose (for local databases)

### 1 — Clone and install

```bash
git clone https://github.com/your-org/fuhsox-backend.git
cd fuhsox-backend
npm install
```

### 2 — Environment

```bash
cp .env.example .env
# Fill in all values — especially JWT secrets, Anthropic key, AWS credentials
```

### 3 — Start local infrastructure

```bash
docker compose up -d
# Starts: PostgreSQL, MongoDB, Redis, MailHog (SMTP web UI at http://localhost:8025)
```

### 4 — Database setup

```bash
npm run db:generate    # Generate Prisma client from schema
npm run db:migrate     # Run migrations
npm run db:seed        # Seed institution, badges, admin user, sample questions
```

### 5 — Start the development server

```bash
npm run dev
# API: http://localhost:4000
# Health: http://localhost:4000/api/v1/health
```

---

## Environment Variables

See `.env.example` for the full annotated list. Key variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `MONGODB_URI` | MongoDB connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_ACCESS_SECRET` | Min 32-char secret for access tokens (15-min expiry) |
| `JWT_REFRESH_SECRET` | Min 32-char secret for refresh tokens (30-day expiry) |
| `ANTHROPIC_API_KEY` | Claude API key (must start with `sk-ant-`) |
| `AWS_S3_BUCKET` | S3 bucket for file uploads |
| `AWS_SES_FROM_EMAIL` | Verified SES sender email |
| `SENTRY_DSN` | Optional Sentry DSN for error tracking |

---

## Database Setup

### Migrations

```bash
npm run db:migrate          # Apply pending migrations (dev)
npm run db:deploy           # Apply migrations (production — no prompt)
npm run db:studio           # Open Prisma Studio GUI
```

### Seeding

```bash
npm run db:seed

# Override seed admin credentials via env:
SEED_ADMIN_EMAIL=admin@fuhso.edu.ng SEED_ADMIN_PASSWORD=SecurePass! npm run db:seed
```

The seed creates:
- **1 institution** — Federal University of Health Sciences, Otukpo
- **7 badge definitions** — First Quiz, Week Warrior, Iron Scholar, Precision Mind, Perfect Score, Quiz Master, Social Connector
- **1 superadmin user**
- **5 sample published questions** (dev only)
- **1 sample event + 1 news article** (dev only)

---

## Running the Server

```bash
npm run dev     # Development (hot reload)
npm run build   # Compile TypeScript
npm start       # Production (requires build first)
```

---

## Running Workers Separately

For production, run the API server and background workers as separate processes:

```bash
# Process 1 — API server
npm start

# Process 2 — Background workers (email, PDF parsing)
npm run workers:start
```

---

## API Reference

All endpoints are prefixed `/api/v1/`.  
All responses follow the envelope: `{ success: boolean, data: T | null, error?: { code, message, details? } }`.

### Authentication

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/register` | ❌ | Initiate OTP for email |
| `POST` | `/auth/verify` | ❌ | Verify OTP → access token + refresh cookie |
| `GET` | `/auth/google` | ❌ | Get Google OAuth consent URL |
| `POST` | `/auth/google/callback` | ❌ | Exchange code for session |
| `POST` | `/auth/refresh` | Cookie | Rotate refresh token |
| `POST` | `/auth/logout` | ✅ | Revoke refresh token |
| `POST` | `/auth/forgot-password` | ❌ | Send password reset link |
| `POST` | `/auth/reset-password` | ❌ | Complete password reset |

### Users & Social

| Method | Path | Description |
|---|---|---|
| `GET` | `/users/me` | Get my profile + unread count |
| `PATCH` | `/users/me` | Update profile, bio, interests, notification prefs |
| `POST` | `/users/me/avatar` | Upload avatar (multipart/form-data) |
| `GET` | `/users/discover` | Peer discovery with filters & sort |
| `GET` | `/users/:id` | Public profile (same institution only) |
| `POST` | `/users/:id/connect` | Send connection request |
| `PATCH` | `/users/connections/:id` | Accept or decline connection |

### Questions

| Method | Path | Description |
|---|---|---|
| `GET` | `/questions` | Browse published questions (filters: course, faculty, year, difficulty, type, topic, search) |
| `GET` | `/questions/bookmarks` | My bookmarked questions |
| `POST` | `/questions/:id/bookmark` | Toggle bookmark |

### Quiz Sessions

| Method | Path | Description |
|---|---|---|
| `POST` | `/sessions` | Create session (past_questions / ai_generated / bookmarks / mixed) |
| `GET` | `/sessions` | My session history (optional `?stats=true`) |
| `GET` | `/sessions/:id` | Session detail with answers and AI feedback |
| `POST` | `/sessions/:id/answers` | Submit an answer |
| `POST` | `/sessions/:id/complete` | Finalize session → score + XP + badges |

### AI Features

| Method | Path | Description |
|---|---|---|
| `GET` | `/ai/usage` | Today's AI usage vs daily limit |
| `POST` | `/ai/questions` | Generate practice questions with Claude |
| `POST` | `/ai/study-plan` | Generate personalized study plan |

### Social Feed

| Method | Path | Description |
|---|---|---|
| `GET` | `/feed` | Institution feed (paginated) |
| `POST` | `/feed` | Create post |
| `DELETE` | `/feed/:id` | Delete own post (admin can delete any) |
| `POST` | `/feed/:id/like` | Toggle like |
| `GET` | `/feed/:id/comments` | List comments |
| `POST` | `/feed/:id/comments` | Add comment (supports threaded replies) |
| `POST` | `/feed/:id/report` | Report post |

### Messages

| Method | Path | Description |
|---|---|---|
| `GET` | `/messages` | List all conversation threads |
| `GET` | `/messages/:userId` | Message history with a user |
| `DELETE` | `/messages/:id` | Soft-delete own message |

### Study Schedules

| Method | Path | Description |
|---|---|---|
| `GET` | `/study/schedules` | My active study schedules with adherence rate |
| `POST` | `/study/schedules` | Create schedule |
| `PATCH` | `/study/schedules/:id` | Update schedule |
| `DELETE` | `/study/schedules/:id` | Deactivate schedule |

### Leaderboard

| Method | Path | Description |
|---|---|---|
| `GET` | `/leaderboard` | Ranked by XP (`?scope=institution\|faculty\|department&value=...`) |

### Notifications

| Method | Path | Description |
|---|---|---|
| `GET` | `/notifications` | My notifications (paginated) |
| `PATCH` | `/notifications/:id/read` | Mark one as read |
| `PATCH` | `/notifications/read-all` | Mark all as read |

### News & Events (Student)

| Method | Path | Description |
|---|---|---|
| `GET` | `/news` | Published articles (pinned first) |
| `GET` | `/news/:id` | Single article |
| `GET` | `/events` | Upcoming events |

### Admin

All admin routes require `role: admin` or `role: superadmin`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/analytics/overview` | Key metrics (cached 5 min) |
| `GET` | `/admin/analytics/students` | Sign-up trends, DAU, faculty breakdown |
| `GET` | `/admin/analytics/quizzes` | Quiz volume, scores, top courses |
| `GET` | `/admin/analytics/ai` | AI feature usage and token costs |
| `GET` | `/admin/students` | Paginated student list with filters |
| `GET` | `/admin/students/at-risk` | Risk-flagged students |
| `GET` | `/admin/students/:id` | Full student detail with stats |
| `PATCH` | `/admin/students/:id/flag` | Set or clear risk flag |
| `GET` | `/admin/questions` | All questions with admin filters |
| `POST` | `/admin/questions` | Create a question manually |
| `PUT` | `/admin/questions/:id` | Full question update |
| `PATCH` | `/admin/questions/:id/status` | Status workflow (draft→review→published→archived) |
| `PATCH` | `/admin/questions/bulk-status` | Bulk status update |
| `POST` | `/admin/questions/upload/pdf` | Upload PDF → async AI parse |
| `POST` | `/admin/questions/upload/csv` | Bulk import via CSV |
| `GET` | `/admin/questions/jobs/pdf` | List PDF parse jobs |
| `GET` | `/admin/questions/jobs/pdf/:id` | PDF parse job status |
| `GET` | `/admin/events` | All events |
| `POST` | `/admin/events` | Create event |
| `PUT` | `/admin/events/:id` | Update event |
| `POST` | `/admin/events/:id/publish` | Publish event → notifies audience |
| `DELETE` | `/admin/events/:id` | Cancel event |
| `GET` | `/admin/broadcasts` | Broadcast history |
| `GET` | `/admin/broadcasts/:id` | Broadcast detail with delivery stats |
| `POST` | `/admin/broadcasts` | Send broadcast email |
| `GET` | `/admin/news` | All articles |
| `POST` | `/admin/news` | Create article |
| `PUT` | `/admin/news/:id` | Update article |
| `POST` | `/admin/news/:id/publish` | Publish article |
| `PATCH` | `/admin/news/:id/pin` | Toggle pin |

---

## Real-Time Events (Socket.io)

Connect with `{ auth: { token: '<access_token>' } }`.

### Client → Server

| Event | Payload | Description |
|---|---|---|
| `message:send` | `{ receiver_id, body }` | Send a DM (must be connected peers) |
| `message:read` | `{ sender_id }` | Mark messages from sender as read |
| `quiz:request_feedback` | `{ session_id, question_id, chosen_answer }` | Request streaming AI feedback |

### Server → Client

| Event | Payload | Description |
|---|---|---|
| `connected` | `{ userId, message }` | Connection confirmed |
| `message:new` | Message object | Incoming DM |
| `message:sent` | Message object | DM delivery confirmed to sender |
| `message:read_receipt` | `{ reader_id }` | Messages marked as read by peer |
| `message:error` | `{ message }` | DM send failure |
| `notification:new` | Notification object | Real-time in-app notification |
| `quiz:feedback_token` | `{ session_id, question_id, token }` | Streaming AI feedback chunk |
| `quiz:feedback_complete` | `{ session_id, question_id }` | Feedback stream ended |
| `quiz:feedback_error` | `{ message }` | Feedback generation failed |

---

## Background Jobs & Cron Schedulers

### BullMQ Queues

| Queue | Workers | Description |
|---|---|---|
| `email` | 10 concurrent | Renders Handlebars template → sends via AWS SES (dev: Nodemailer) |
| `pdf` | 2 concurrent | Downloads PDF from S3 → extracts text → Claude parses questions → saves as drafts |

### Cron Schedulers

| Cron | Schedule (UTC) | WAT Equivalent | Description |
|---|---|---|---|
| Study Reminder | `0 17 * * *` | 6 PM | Sends reminder emails+notifications per student schedule and quiet-hour prefs |
| Risk Flag | `0 1 * * *` | 2 AM | Flags inactive students (8+ days) or accuracy drop (≥25%). Sends re-engagement emails (14+ days inactive, once per 7 days) |
| Scheduled Content | `*/5 * * * *` | Every 5 min | Auto-publishes events and news articles whose `scheduled_for` time has arrived |

---

## Multi-Tenancy

Every data model carries an `institution_id`. The `scopeToInstitution` middleware (applied on all authenticated routes) reads the `institution_id` from the JWT payload and attaches it to `req.institutionId`. Every service query **must** include `WHERE institution_id = req.institutionId`. Cross-institution data access returns `404 NOT_FOUND` (for students) or `403 FORBIDDEN` (for admin actions).

---

## Authentication Flow

### Email OTP
```
Client               API                  Redis / DB            Email
  │                   │                       │                   │
  │──POST /register──▶│                       │                   │
  │                   │──validate domain──────▶│                   │
  │                   │──create OTPRequest─────▶│                   │
  │                   │──enqueue email─────────────────────────────▶│
  │◀──200 OTP sent────│                       │                   │
  │                   │                       │                   │
  │──POST /verify─────▶│                       │                   │
  │  (email + otp)    │──bcrypt verify─────────▶│                   │
  │                   │──mark OTP used──────────▶│                   │
  │                   │──upsert user────────────▶│                   │
  │                   │──issue refresh token────▶│                   │
  │◀─200 accessToken  │                       │                   │
  │  Set-Cookie: refresh_token (HttpOnly)     │                   │
```

### Token Refresh (Rotation)
- Access tokens expire in **15 minutes**
- Refresh tokens expire in **30 days**, stored as bcrypt hashes
- On each refresh: old token is revoked, new pair issued
- **Breach detection**: if an already-revoked token is submitted, ALL sessions for that user are immediately terminated

---

## Gamification System

### XP Rewards

| Action | XP |
|---|---|
| Correct answer | +10 |
| Perfect score (100%) | +50 bonus |
| AI question generated | +5 |
| Badge: First Quiz | +50 |
| Badge: Week Warrior (7-day streak) | +100 |
| Badge: Iron Scholar (30-day streak) | +500 |
| Badge: Precision Mind (90% accuracy) | +150 |
| Badge: Perfect Score | +200 |
| Badge: Quiz Master (50 sessions) | +300 |

### Streak Logic
- Increments once per calendar day (WAT timezone)
- Resets to 1 if a day is skipped
- Evaluated after each completed session

---

## AI Features

### Question Generation
- Model: `claude-opus-4-6`
- Per-institution configurable daily limit (default: 50 questions/user/day)
- Supports: MCQ, short answer, fill-in-the-blank
- Difficulty levels: easy, medium, hard
- Saved to MongoDB `AIQuestion` collection with quality flag

### Quiz Feedback (Streaming)
- Triggered via Socket.io `quiz:request_feedback` event
- Streams token-by-token via `quiz:feedback_token` events
- Full feedback saved to MongoDB `AIFeedback` collection
- Linked to `SessionAnswer.ai_feedback_id`

### Study Plan Generation
- Produces week-by-week structured plan
- Persisted to MongoDB `StudyPlan` collection (one per user, upserted)
- Includes daily tasks with subject, topic, duration, activity type, and recommended question set

### PDF Question Parsing
- Admin uploads PDF → stored in S3
- BullMQ job extracts text → sends to Claude → parses questions → saves as draft questions
- Job status tracked in PostgreSQL `PDFParseJob` table

---

## Email System

### Templates (Handlebars)

| Template | Trigger |
|---|---|
| `otp.hbs` | Email OTP login |
| `event-notification.hbs` | Event published to audience |
| `study-reminder.hbs` | Daily study reminder |
| `exam-countdown.hbs` | 1–3 days before exam |
| `re-engagement.hbs` | 14+ days of inactivity |
| `broadcast.hbs` | Admin-composed broadcast |
| `password-reset.hbs` | Password reset link |

All emails are queued via BullMQ (`email` queue) and processed by the email worker. In development, emails are delivered to MailHog at `http://localhost:8025`.

---

## Testing

```bash
npm test                  # All tests
npm run test:unit         # Unit tests only
npm run test:integration  # Integration tests only
npm run test:coverage     # Coverage report
```

### Test architecture
- **Unit tests** — Pure logic: XP calculations, streak evaluation, OTP hashing
- **Integration tests** — Supertest against the real Express app with:
  - PostgreSQL (real test DB — set `DATABASE_URL` to a test database)
  - MongoDB (in-memory via `mongodb-memory-server`)
  - Email/AI/PDF queues mocked via `jest.mock`

---

## Deployment

### Environment variables
Set all variables from `.env.example` in your deployment environment.

### Database migrations
```bash
npm run db:deploy    # Runs Prisma migrations without prompts
npm run db:seed      # Optional — seed badges and first institution
```

### Build and start
```bash
npm run build
npm start
```

### Docker (recommended for production)
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run db:generate && npm run build

FROM node:20-alpine AS runner
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/email-templates ./email-templates
COPY --from=builder /app/prisma ./prisma
COPY package.json ./
EXPOSE 4000
CMD ["npm", "start"]
```

### Separate worker process
For production scale, run the API and workers as separate processes or containers:
```bash
# API container
CMD ["npm", "start"]

# Worker container
CMD ["npm", "run", "workers:start"]
```

---

## Security Notes

- All OTPs are bcrypt-hashed before storage
- Refresh tokens are bcrypt-hashed; raw tokens never stored
- Token reuse triggers full session revocation (breach detection)
- Multi-tenant isolation enforced at middleware + query level
- Rate limiting via Redis on all auth and sensitive endpoints
- HTML post content sanitized via `sanitize-html` before storage
- File uploads validated by MIME type and size limits
- Sensitive fields (`password_hash`, `google_id`) stripped from all API responses

---

*Powered by Revision Software Foundation · FuhsoX v1.0*
