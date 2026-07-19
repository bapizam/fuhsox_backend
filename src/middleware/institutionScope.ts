import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { fail } from '@utils/response';

/**
 * Institution Scope Middleware — enforces multi-tenant data isolation.
 *
 * Ensures that `req.institutionId` is set (from the JWT payload) and matches
 * the authenticated user's institution. This MUST be applied after `authenticate`
 * on every route that accesses institution-scoped data.
 *
 * Every Prisma/Mongoose query in services MUST include
 * `WHERE institution_id = req.institutionId` — this middleware provides the value.
 */
export const scopeToInstitution: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (!req.user?.institution_id) {
    res.status(403).json(
      fail('NO_INSTITUTION', 'Cannot determine institution context from token'),
    );
    return;
  }

  // Ensure institutionId is always in sync with the token payload
  req.institutionId = req.user.institution_id;
  next();
};

/**
 * Verify that a resource's institution_id matches the request institution.
 * Throws 403 FORBIDDEN if not.
 *
 * Use in controllers after fetching resources.
 */
export function assertInstitutionMatch(
  resourceInstitutionId: string,
  requestInstitutionId: string,
): void {
  if (resourceInstitutionId !== requestInstitutionId) {
    throw Object.assign(
      new Error('Access denied: cross-institution resource access'),
      { statusCode: 403, code: 'FORBIDDEN' },
    );
  }
}

export default scopeToInstitution;
