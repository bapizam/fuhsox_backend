import { Router, type Request, type Response } from 'express';
import authRoutes from './auth.routes';
import userRoutes from './user.routes';
import questionRoutes from './question.routes';
import sessionRoutes from './session.routes';
import aiRoutes from './ai.routes';
import learningRoutes from './learning.routes';
import configRoutes from './config.routes';
import feedRoutes from './feed.routes';
import adminRoutes from './admin.routes';
import roomsRoutes from './rooms.routes';
import deviceRoutes from './devices.routes';
import {
  notificationRouter,
  messageRouter,
  studyRouter,
  leaderboardRouter,
  newsRouter,
  eventsRouter,
} from './misc.routes';
import { getQueueStats } from '@jobs/queues';
import { ok } from '@utils/response';
import asyncHandler from '@middleware/asyncHandler';
import authenticate from '@middleware/authenticate';
import { superAdminOnly } from '@middleware/authorize';

const router = Router();

// ─── Health Checks ─────────────────────────────────────────────────────────────

router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

router.get('/health/queues', authenticate, superAdminOnly, asyncHandler(async (_req: Request, res: Response) => {
  const stats = await getQueueStats();
  res.status(200).json(ok(stats));
}));

// ─── Authentication ────────────────────────────────────────────────────────────
router.use('/auth', authRoutes);

// ─── Reference Data ─────────────────────────────────────────────────────────────
router.use('/config', configRoutes);

// ─── Users & Social ────────────────────────────────────────────────────────────
router.use('/users', userRoutes);
router.use('/devices', deviceRoutes);
router.use('/feed', feedRoutes);
router.use('/messages', messageRouter);
router.use('/notifications', notificationRouter);

// ─── Quiz & Content ────────────────────────────────────────────────────────────
router.use('/questions', questionRoutes);
router.use('/sessions', sessionRoutes);

// ─── AI Features ──────────────────────────────────────────────────────────────
router.use('/ai', aiRoutes);

// ─── Study & Progress ─────────────────────────────────────────────────────────
router.use('/study', studyRouter);
// Adaptive learning engine (M7 item 4). Coexists with /study rather than
// replacing it: schedules answer "when do I study", objectives answer "what have
// I actually proven".
router.use('/learning', learningRoutes);
router.use('/rooms', roomsRoutes);
router.use('/leaderboard', leaderboardRouter);

// ─── Institution Content ──────────────────────────────────────────────────────
router.use('/news', newsRouter);
router.use('/events', eventsRouter);

// ─── Admin Panel ──────────────────────────────────────────────────────────────
router.use('/admin', adminRoutes);

// ─── 404 Handler ──────────────────────────────────────────────────────────────
router.all('*', (req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    data: null,
    error: {
      code:    'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
    },
  });
});

export default router;
