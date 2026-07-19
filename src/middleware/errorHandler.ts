import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import * as Sentry from '@sentry/node';
import { ZodError } from 'zod';
import { env } from '@config/env';
import { fail } from '@utils/response';
import { AppError } from '@typings/models';
import logger from '@lib/logger';

/**
 * Global error handler middleware.
 * Must be registered LAST in the Express middleware chain.
 *
 * Handles:
 * - AppError (our custom errors with explicit code + status)
 * - ZodError (validation failures from service-layer Zod parsing)
 * - Prisma P2002 (unique constraint violation)
 * - Prisma P2025 (record not found)
 * - JWT errors
 * - Generic 500 errors
 */
export const globalErrorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  // Always log the error
  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');

  // Report to Sentry (non-blocking)
  Sentry.captureException(err);

  // ─── AppError (our domain errors) ─────────────────────────────────────────
  if (err instanceof AppError) {
    res.status(err.statusCode).json(fail(err.code, err.message, err.details));
    return;
  }

  // ─── Zod validation error ──────────────────────────────────────────────────
  if (err instanceof ZodError) {
    res.status(422).json(fail('VALIDATION_ERROR', 'Invalid request data', err.flatten().fieldErrors));
    return;
  }

  // ─── Prisma errors ─────────────────────────────────────────────────────────
  if (isObject(err) && 'code' in err) {
    const prismaError = err as { code: string; meta?: { target?: string[] } };

    if (prismaError.code === 'P2002') {
      const field = prismaError.meta?.target?.[0] ?? 'field';
      res.status(409).json(fail('CONFLICT', `A record with this ${field} already exists`));
      return;
    }

    if (prismaError.code === 'P2025') {
      res.status(404).json(fail('NOT_FOUND', 'Record not found'));
      return;
    }
  }

  // ─── HTTP-aware errors (e.g. from middleware) ──────────────────────────────
  if (isObject(err) && 'statusCode' in err) {
    const httpErr = err as { statusCode: number; code?: string; message?: string };
    res.status(httpErr.statusCode).json(
      fail(httpErr.code ?? 'ERROR', httpErr.message ?? 'An error occurred'),
    );
    return;
  }

  // ─── Generic 500 ──────────────────────────────────────────────────────────
  const message =
    env.NODE_ENV === 'production'
      ? 'Internal server error'
      : (err instanceof Error ? err.message : String(err));

  res.status(500).json(fail('INTERNAL_ERROR', message));
};

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null;
}

export default globalErrorHandler;
