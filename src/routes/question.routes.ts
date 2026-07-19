import { Router } from 'express';
import authenticate from '@middleware/authenticate';
import scopeToInstitution from '@middleware/institutionScope';
import {
  getQuestions,
  getBookmarks,
  toggleBookmark,
} from '@controllers/controllers';

const router = Router();

router.use(authenticate, scopeToInstitution);

// GET  /api/v1/questions            — browse published questions with filters
router.get('/', getQuestions);

// GET  /api/v1/questions/bookmarks  — get my bookmarked questions
router.get('/bookmarks', getBookmarks);

// POST /api/v1/questions/:id/bookmark — toggle bookmark on a question
router.post('/:id/bookmark', toggleBookmark);

export default router;
