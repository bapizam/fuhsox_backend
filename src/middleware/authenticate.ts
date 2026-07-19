import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '@config/env';
import { fail } from '@utils/response';
import type { JWTPayload } from '@typings/models';
import prisma from '@config/database';

/**
 * Authenticate middleware — verifies the JWT access token and
 * attaches the decoded payload to req.user.
 *
 * Also updates last_active_at on each authenticated request (debounced to ~5 min
 * in practice via the socket connection event; here we do a lightweight no-await update).
 */
// Deliberately synchronous: jwt.verify is sync and the last_active_at update is
// fire-and-forget. An async middleware would hand Express 4 an unhandled
// promise on every request (no rejection handling for returned promises).
export const authenticate = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    res.status(401).json(fail('MISSING_TOKEN', 'Authorization header is required'));
    return;
  }

  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    res.status(401).json(fail('MISSING_TOKEN', 'Bearer token is required'));
    return;
  }

  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as JWTPayload;

    // Attach user context to request
    req.user = {
      id:             payload.sub,
      role:           payload.role as 'student' | 'admin' | 'superadmin',
      institution_id: payload.institution_id,
      email:          '', // populated below if needed
    };

    req.institutionId = payload.institution_id;

    // Fire-and-forget last_active_at update (non-blocking)
    prisma.user
      .update({
        where: { id: payload.sub },
        data: { last_active_at: new Date() },
      })
      .catch(() => {/* silent */});

    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json(fail('TOKEN_EXPIRED', 'Access token has expired'));
      return;
    }
    res.status(401).json(fail('INVALID_TOKEN', 'Invalid or malformed access token'));
  }
};

export default authenticate;
