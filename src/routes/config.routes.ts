import { Router, type Request, type Response } from 'express';
import authenticate from '@middleware/authenticate';
import { ok } from '@utils/response';
import { ACADEMIC_FACULTIES, resolveInterests } from '@config/academic';

/**
 * Static academic reference data — faculties, departments and department-aware
 * study interests. Institution-agnostic, so it needs auth (onboarding is
 * post-login) but NOT institution scope.
 */
const router = Router();

router.use(authenticate);

// GET /api/v1/config/academic — the full faculty → department → interests tree.
//   Small (~few KB) and stable, so the client fetches once and caches it. Static
//   data, no async work — a sync handler; Express propagates any throw.
router.get('/academic', (_req: Request, res: Response) => {
  res.status(200).json(ok({ faculties: ACADEMIC_FACULTIES }));
});

// GET /api/v1/config/interests?faculty=&department= — resolved suggestions for a
//   pair, applying the department-first, faculty-fallback rule server-side. A
//   convenience for callers that don't want to hold the whole tree.
router.get('/interests', (req: Request, res: Response) => {
  const faculty = typeof req.query.faculty === 'string' ? req.query.faculty : undefined;
  const department = typeof req.query.department === 'string' ? req.query.department : undefined;
  res.status(200).json(ok({ interests: resolveInterests(faculty, department) }));
});

export default router;
