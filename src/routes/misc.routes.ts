import { Router } from 'express';
import authenticate from '@middleware/authenticate';
import scopeToInstitution from '@middleware/institutionScope';
import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getConversations,
  getMessageHistory,
  deleteMessage,
  getSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  checkInSchedule,
  getLeaderboard,
  getNews,
  getNewsById,
  getEvents,
} from '@controllers/controllers';

// ══════════════════════════════════════════════════════════════════════════════
// NOTIFICATION ROUTES  /api/v1/notifications
// ══════════════════════════════════════════════════════════════════════════════

export const notificationRouter = Router();
notificationRouter.use(authenticate, scopeToInstitution);

notificationRouter.get('/',        getNotifications);
notificationRouter.patch('/read-all', markAllNotificationsRead);    // must come before /:id
notificationRouter.patch('/:id/read', markNotificationRead);

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGE ROUTES  /api/v1/messages
// ══════════════════════════════════════════════════════════════════════════════

export const messageRouter = Router();
messageRouter.use(authenticate, scopeToInstitution);

// GET  /api/v1/messages/conversations          — list threads
messageRouter.get('/conversations', getConversations);

// GET  /api/v1/messages/:userId/history        — message history with a user
messageRouter.get('/:userId/history', getMessageHistory);

// DELETE /api/v1/messages/:id                  — soft-delete own message
messageRouter.delete('/:id', deleteMessage);

// ══════════════════════════════════════════════════════════════════════════════
// STUDY SCHEDULE ROUTES  /api/v1/study
// ══════════════════════════════════════════════════════════════════════════════

export const studyRouter = Router();
studyRouter.use(authenticate, scopeToInstitution);

studyRouter.get('/schedules',    getSchedules);
studyRouter.post('/schedules',   createSchedule);
studyRouter.patch('/schedules/:id',  updateSchedule);
studyRouter.delete('/schedules/:id', deleteSchedule);
studyRouter.post('/schedules/:id/check-in', checkInSchedule);

// ══════════════════════════════════════════════════════════════════════════════
// LEADERBOARD ROUTES  /api/v1/leaderboard
// ══════════════════════════════════════════════════════════════════════════════

export const leaderboardRouter = Router();
leaderboardRouter.use(authenticate, scopeToInstitution);

leaderboardRouter.get('/', getLeaderboard);

// ══════════════════════════════════════════════════════════════════════════════
// NEWS & EVENTS ROUTES (Student-Facing)
// ══════════════════════════════════════════════════════════════════════════════

export const newsRouter = Router();
newsRouter.use(authenticate, scopeToInstitution);

newsRouter.get('/',    getNews);
newsRouter.get('/:id', getNewsById);

export const eventsRouter = Router();
eventsRouter.use(authenticate, scopeToInstitution);

eventsRouter.get('/', getEvents);
