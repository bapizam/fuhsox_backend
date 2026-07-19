import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { fail } from '@utils/response';
import type { Role } from '@typings/models';

/**
 * Role-based access control middleware factory.
 *
 * Usage:
 *   router.get('/admin/...', authenticate, authorize('admin', 'superadmin'), handler)
 */
export const authorize = (...allowedRoles: Role[]): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json(fail('MISSING_TOKEN', 'Authentication required'));
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json(
        fail('FORBIDDEN', `Access denied. Required role: ${allowedRoles.join(' or ')}`),
      );
      return;
    }

    next();
  };
};

/** Shorthand for admin-only routes (admin or superadmin). */
export const adminOnly: RequestHandler = authorize('admin', 'superadmin');

/** Shorthand for superadmin-only routes. */
export const superAdminOnly: RequestHandler = authorize('superadmin');

export default authorize;
