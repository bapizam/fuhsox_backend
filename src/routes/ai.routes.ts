import { Router } from 'express';
import authenticate from '@middleware/authenticate';
import scopeToInstitution from '@middleware/institutionScope';
import {
  generateAIQuestions,
  generateStudyPlan,
  getAIUsageToday,
  getMyStudyPlan,
  updateStudyPlanTask,
  generateSubjectPlan,
  getSubjectPlan,
  listSubjectPlans,
  updateSubjectPlanTask,
  updateSubjectPlanTaskRead,
  getMyAIFeedback,
  getAIHistory,
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

// ─── Per-resource study plan (single-subject plan, Phase 2) ──────────────────
// Anchored to ONE uploaded resource, so every task names a real SyllabusNode and
// carries its page range. The multi-subject `/generate-plan` above is untouched
// and both continue to work.
// POST  /api/v1/ai/plan/resource        — generate. ONE AI call (a second only if
//       the first returned nothing usable). 422 when the resource has no outline.
router.post('/plan/resource', generateSubjectPlan);
// GET   /api/v1/ai/plan/resource        — every per-resource plan the student has
router.get('/plan/resource', listSubjectPlans);
// GET   /api/v1/ai/plan/resource/:id    — the live plan for one resource id
router.get('/plan/resource/:id', getSubjectPlan);
// PATCH /api/v1/ai/plan/resource/task   — toggle one task's completed flag
router.patch('/plan/resource/task',      updateSubjectPlanTask);
router.patch('/plan/resource/task/read', updateSubjectPlanTaskRead);

// GET  /api/v1/ai/feedback/me           — AI feedback history for current user
router.get('/feedback/me', getMyAIFeedback);

// GET  /api/v1/ai/history               — unified AI timeline: forged questions,
//      tutor feedback, mastery attempts and plan generations, newest first.
//      ?kind=all|question|feedback|mastery|plan &page= &limit= &search=
//      ZERO AI calls — pure reads.
router.get('/history', getAIHistory);

// POST /api/v1/ai/questions/:id/flag    — flag a generated question as low-quality
router.post('/questions/:id/flag', flagAIQuestion);

export default router;
