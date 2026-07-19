import { Router } from 'express';
import authenticate from '@middleware/authenticate';
import scopeToInstitution from '@middleware/institutionScope';
import { adminOnly } from '@middleware/authorize';
import * as admin from '@controllers/admin/admin.controllers';

const router = Router();

// All admin routes: authenticated + institution-scoped + admin role required
router.use(authenticate, scopeToInstitution, adminOnly);

// ── Analytics ─────────────────────────────────────────────────────────────────
router.get('/analytics/overview',  admin.getAnalyticsOverview);
router.get('/analytics/students',  admin.getStudentAnalytics);
router.get('/analytics/quizzes',   admin.getQuizAnalytics);
router.get('/analytics/ai',        admin.getAIAnalytics);

// ── Audience Preview ──────────────────────────────────────────────────────────
// GET /admin/audience-preview?target=all|faculty|department&value=...
router.get('/audience-preview', admin.getAudiencePreview);

// ── Student Management ────────────────────────────────────────────────────────
router.get('/students',           admin.adminListStudents);
router.get('/students/at-risk',   admin.adminGetAtRiskStudents);
router.get('/students/:id',       admin.adminGetStudent);
router.patch('/students/:id/flag', admin.adminFlagStudent);

// ── Question Management ───────────────────────────────────────────────────────
router.get('/questions',                     admin.adminGetQuestions);
router.post('/questions',                    admin.adminCreateQuestion);
router.patch('/questions/bulk-status',       admin.adminBulkUpdateStatus);
router.put('/questions/:id',                 admin.adminUpdateQuestion);
router.patch('/questions/:id/status',        admin.adminUpdateQuestionStatus);
// File uploads
// Single unified upload endpoint — detects PDF vs CSV by MIME type
router.post('/questions/upload',     admin.unifiedUpload.single('file'), admin.adminUploadFile);
// Keep explicit CSV endpoint as an alias for clarity
router.post('/questions/upload/csv', admin.csvUpload.single('file'),     admin.adminUploadCSV);
// Parse job status
router.get('/questions/jobs/pdf',            admin.adminListPDFJobs);
router.get('/questions/jobs/pdf/:id',        admin.adminGetPDFJob);

// ── Event Management ──────────────────────────────────────────────────────────
router.get('/events',              admin.adminListEvents);
router.post('/events',             admin.adminCreateEvent);
router.put('/events/:id',          admin.adminUpdateEvent);
router.post('/events/:id/publish', admin.adminPublishEvent);
router.delete('/events/:id',       admin.adminCancelEvent);

// ── Broadcast / Email ─────────────────────────────────────────────────────────
router.get('/broadcasts',          admin.adminGetBroadcasts);
router.get('/broadcasts/:id',      admin.adminGetBroadcastDetail);
router.post('/broadcasts',         admin.adminSendBroadcast);

// ── News Management ───────────────────────────────────────────────────────────
router.get('/news',                admin.adminListArticles);
router.post('/news',               admin.adminCreateArticle);
router.put('/news/:id',            admin.adminUpdateArticle);
router.post('/news/:id/publish',   admin.adminPublishArticle);
router.patch('/news/:id/pin',      admin.adminTogglePin);

export default router;
