import { Router } from 'express';
import authenticate from '@middleware/authenticate';
import scopeToInstitution from '@middleware/institutionScope';
import {
  generateAIQuestions,
  getAIUsageToday,
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

// ─── Study plans ─────────────────────────────────────────────────────────────
// Anchored to ONE uploaded resource, so every task names a real SyllabusNode and
// carries its page range.
//
// `POST /generate-plan`, `GET /plan/me` and `PATCH /plan/me/task` — the older
// planner over a free-text list of subjects — were RETIRED here. It could not
// ground itself in anything the student owned, could not sequence its tasks, and
// emitted a `recommended_question_set` string that pointed at nothing; leaving it
// live meant a student could hold two plans that disagreed about Tuesday. Its
// Mongo collections are deliberately untouched, so nothing anyone generated has
// been destroyed.
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
