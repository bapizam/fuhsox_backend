import { Router } from 'express';
import authenticate from '@middleware/authenticate';
import scopeToInstitution from '@middleware/institutionScope';
import {
  generateAIQuestions,
  generateStudyPlan,
  getAIUsageToday,
  getMyStudyPlan,
  updateStudyPlanTask,
  getMyAIFeedback,
  flagAIQuestion,
} from '@controllers/controllers';

const router = Router();

router.use(authenticate, scopeToInstitution);

// GET  /api/v1/ai/usage                 — today's AI usage vs daily limit
router.get('/usage', getAIUsageToday);

// POST /api/v1/ai/generate-questions    — generate practice questions with Claude
router.post('/generate-questions', generateAIQuestions);

// POST /api/v1/ai/generate-plan         — generate personalised study plan
router.post('/generate-plan', generateStudyPlan);

// GET  /api/v1/ai/plan/me               — retrieve current study plan
router.get('/plan/me', getMyStudyPlan);

// PATCH /api/v1/ai/plan/me/task         — toggle one plan task's completed flag
router.patch('/plan/me/task', updateStudyPlanTask);

// GET  /api/v1/ai/feedback/me           — AI feedback history for current user
router.get('/feedback/me', getMyAIFeedback);

// POST /api/v1/ai/questions/:id/flag    — flag a generated question as low-quality
router.post('/questions/:id/flag', flagAIQuestion);

export default router;
