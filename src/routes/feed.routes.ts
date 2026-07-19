import { Router } from 'express';
import authenticate from '@middleware/authenticate';
import scopeToInstitution from '@middleware/institutionScope';
import {
  getFeed,
  getFeedTrending,
  createPost,
  getPostById,
  toggleLike,
  deletePost,
  addComment,
  getComments,
  reportPost,
} from '@controllers/controllers';

const router = Router();

router.use(authenticate, scopeToInstitution);

// ─── Feed ──────────────────────────────────────────────────────────────────────
// GET  /api/v1/feed                — connected-user feed with cursor pagination
router.get('/', getFeed);

// GET  /api/v1/feed/trending       — trending topics (Redis-cached, 1-hour TTL)
router.get('/trending', getFeedTrending);

// ─── Posts ─────────────────────────────────────────────────────────────────────
// POST   /api/v1/feed/posts        — create a post
router.post('/posts', createPost);

// GET    /api/v1/feed/posts/:id    — get post detail with top-level comments + replies
router.get('/posts/:id', getPostById);

// DELETE /api/v1/feed/posts/:id    — soft-delete (owner or admin)
router.delete('/posts/:id', deletePost);

// POST   /api/v1/feed/posts/:id/like     — toggle like
router.post('/posts/:id/like', toggleLike);

// GET    /api/v1/feed/posts/:id/comments — list comments
router.get('/posts/:id/comments', getComments);

// POST   /api/v1/feed/posts/:id/comments — add comment / reply
router.post('/posts/:id/comments', addComment);

// POST   /api/v1/feed/posts/:id/report   — report a post
router.post('/posts/:id/report', reportPost);

export default router;
