import 'dotenv/config';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import * as Sentry from '@sentry/node';

import { env } from '@config/env';
import { globalLimiter } from '@middleware/rateLimiter';
import { globalErrorHandler } from '@middleware/errorHandler';
import router from '@routes/index';
import logger from '@lib/logger';

// ─── Sentry v8 Initialisation ─────────────────────────────────────────────────
// Must be called BEFORE any other imports/instrumentation.
// In v8, Sentry.init() automatically instruments Express — no manual
// requestHandler/tracingHandler/errorHandler middleware is needed.

if (env.SENTRY_DSN) {
  Sentry.init({
    dsn:              env.SENTRY_DSN,
    environment:      env.NODE_ENV,
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 1.0,
  });
}

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();

// ─── Security Headers ──────────────────────────────────────────────────────────

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy:     env.NODE_ENV === 'production' ? undefined : false,
  }),
);

// ─── CORS ─────────────────────────────────────────────────────────────────────

app.use(
  cors({
    origin:         [env.FRONTEND_URL, 'http://192.168.1.42:3000'],
    credentials:    true,
    methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  }),
);

// ─── Request Parsing ──────────────────────────────────────────────────────────

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(cookieParser());

// ─── HTTP Request Logging ─────────────────────────────────────────────────────

app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === '/api/v1/health',
    },
    customLogLevel: (_req, res) => {
      if (res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  }),
);

// ─── Trust Proxy ──────────────────────────────────────────────────────────────
// Required for accurate client IP detection when behind a reverse proxy / ELB.

app.set('trust proxy', 1);

// ─── Global Rate Limiter ──────────────────────────────────────────────────────
// Skip rate limiting in test mode — tests don't have Redis and shouldn't be
// blocked by rate limits.  Unit/integration tests mock the queue layer anyway.

if (env.NODE_ENV !== 'test') {
  app.use('/api', globalLimiter);
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  return res.status(200).json({
    status: "success",
    message: "Good"
  })
});

app.use('/api/v1', router);

// ─── Sentry v8 Express Error Handler ─────────────────────────────────────────
// Must be registered AFTER routes but BEFORE the global error handler.
// Sentry.setupExpressErrorHandler replaces the old Sentry.Handlers.errorHandler().

if (env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// ─── Global Error Handler ─────────────────────────────────────────────────────

app.use(globalErrorHandler);

export default app;
