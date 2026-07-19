import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps async route handlers to automatically forward errors to Express error middleware.
 * Eliminates try/catch boilerplate in every controller.
 *
 * Usage:
 *   router.get('/path', asyncHandler(async (req, res) => { ... }))
 */
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export default asyncHandler;
