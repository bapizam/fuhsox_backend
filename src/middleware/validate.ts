import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z, ZodSchema } from 'zod';
import { fail } from '@utils/response';

type ZodTarget = 'body' | 'query' | 'params';

/**
 * Validation middleware factory using Zod schemas.
 * Validates request body, query, or params and returns 422 on failure.
 *
 * Usage:
 *   router.post('/path', validate(MySchema), handler)
 *   router.get('/path', validate(MySchema, 'query'), handler)
 */
export const validate = <T>(
  schema: ZodSchema<T>,
  target: ZodTarget = 'body',
): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);

    if (!result.success) {
      const formattedErrors = result.error.flatten().fieldErrors;
      res.status(422).json(
        fail('VALIDATION_ERROR', 'Request validation failed', formattedErrors),
      );
      return;
    }

    // Replace the target with the parsed (and coerced) data
    (req as unknown as Record<string, unknown>)[target] = result.data;
    next();
  };
};

// ─── Common Zod schemas ────────────────────────────────────────────────────────

export const paginationSchema = z.object({
  page:  z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(12),
});

export const uuidParamSchema = z.object({
  id: z.string().uuid('Invalid resource ID'),
});

export default validate;
