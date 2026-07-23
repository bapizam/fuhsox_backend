import { Router } from 'express';
import authenticate from '@middleware/authenticate';
import scopeToInstitution from '@middleware/institutionScope';
import {
  resourceUpload,
  listResources,
  createResource,
  uploadResourceFile,
  deleteResource,
  setOutline,
  extractOutline,
  listObjectives,
  generateObjectives,
  startMasteryCheck,
  startTopicMasteryCheck,
  completeMasteryCheck,
  getLearnerModel,
  getRemediation,
  recordExamOutcome,
  listExamOutcomes,
  deleteExamOutcome,
  getReadinessCalibration,
  getKcGraph,
  mapObjectivesToKcs,
} from '@controllers/learning.controller';

const router = Router();

router.use(authenticate, scopeToInstitution);

// ─── Learner model ────────────────────────────────────────────────────────────
// Registered before /resources/:id-style routes for clarity; paths don't collide.
// GET /api/v1/learning/me — analytics dashboard. Costs ZERO AI calls.
router.get('/me', getLearnerModel);

// ─── Resources ────────────────────────────────────────────────────────────────
// GET    /api/v1/learning/resources            — my resources + their chapters
router.get('/resources', listResources);
// POST   /api/v1/learning/resources            — create (metadata only)
router.post('/resources', createResource);
// POST   /api/v1/learning/resources/:id/file   — attach a PDF (multipart, field `file`)
router.post('/resources/:id/file', resourceUpload.single('file'), uploadResourceFile);
// DELETE /api/v1/learning/resources/:id
router.delete('/resources/:id', deleteResource);

// ─── Syllabus structure ───────────────────────────────────────────────────────
// PUT  /api/v1/learning/resources/:id/outline  — typed chapter list. ZERO AI calls,
//      and the fallback whenever extraction fails or the PDF is a scan.
router.put('/resources/:id/outline', setOutline);
// POST /api/v1/learning/resources/:id/extract  — AI structure extraction. ONE call,
//      cached forever; a resource that already has chapters is a no-op.
router.post('/resources/:id/extract', extractOutline);

// ─── Objectives ───────────────────────────────────────────────────────────────
// GET  /api/v1/learning/objectives             — ?subject= &node_id=
router.get('/objectives', listObjectives);
// POST /api/v1/learning/nodes/:nodeId/objectives — generate on first open. ONE AI
//      call per chapter, cached; deliberately NOT done eagerly for a whole book.
router.post('/nodes/:nodeId/objectives', generateObjectives);

// ─── Mastery checks ───────────────────────────────────────────────────────────
// POST /api/v1/learning/objectives/:id/mastery-check — start. Returns a normal
//      QuizSession id the existing runner plays unmodified.
router.post('/objectives/:id/mastery-check', startMasteryCheck);
// POST /api/v1/learning/topic-check — start a check from a plan task's topic.
//      Upserts a topic objective, then behaves exactly like the route above. This
//      is the plan's evidence gate that replaced the "I've studied" checkbox.
router.post('/topic-check', startTopicMasteryCheck);
// POST /api/v1/learning/objectives/:id/mastery-check/complete — score + advance.
router.post('/objectives/:id/mastery-check/complete', completeMasteryCheck);

// POST /api/v1/learning/objectives/:id/remediation — teach what was missed, then
//      retest it. ONE AI call on a cache miss, zero on a repeat failure. Returns
//      200 with `available:false` when the recorded misconceptions aren't specific
//      enough to teach from safely — that guard is deliberate, not an error.
router.post('/objectives/:id/remediation', getRemediation);

// ─── Exam outcomes ────────────────────────────────────────────────────────────
// The only ground truth in the system: everything else is AI-generated questions
// scored against AI-generated answers. Collection only for now — the model that
// calibrates readiness against these grades is a later phase.
// GET    /api/v1/learning/exam-outcomes
router.get('/exam-outcomes', listExamOutcomes);
// POST   /api/v1/learning/exam-outcomes      — self-reported grade
router.post('/exam-outcomes', recordExamOutcome);
// DELETE /api/v1/learning/exam-outcomes/:id  — a mistyped grade must be removable
router.delete('/exam-outcomes/:id', deleteExamOutcome);

// GET /api/v1/learning/readiness-calibration — how the readiness ESTIMATE has
//     actually compared to reported grades, institution-wide (reformation Phase 4,
//     Workstream C read-only slice). Returns `sufficient: false` with a running
//     count until there are 30+ paired observations, and the client shows nothing
//     in that case. Never adjusts readiness — context beside it, never a silent
//     correction. ZERO AI calls.
router.get('/readiness-calibration', getReadinessCalibration);

// ─── Knowledge components (reformation Phase 4, Workstream A) ─────────────────
// GET  /api/v1/learning/kc/graph?subject= — the prerequisite graph plus this
//      student's p_known per component. ZERO AI calls.
router.get('/kc/graph', getKcGraph);
// POST /api/v1/learning/kc/map — map a subject's objectives onto components and
//      propose the edges between them. ONE AI call for the WHOLE subject, and
//      idempotent: re-running attaches new objectives to the existing graph rather
//      than duplicating it. Always 200 — `available:false` on any failure, because
//      the graph is an enhancement and must never break a study session.
router.post('/kc/map', mapObjectivesToKcs);

export default router;
