import { Router } from 'express';
import authenticate from '@middleware/authenticate';
import scopeToInstitution from '@middleware/institutionScope';
import {
  getMe,
  getDashboard,
  updateMe,
  uploadAvatar,
  deleteMe,
  getUserProfile,
  discoverUsers,
  sendConnection,
  listUserConnections,
  respondConnection,
  avatarUpload,
} from '@controllers/controllers';

const router = Router();

// All user routes require authentication + institution scope
router.use(authenticate, scopeToInstitution);

// ─── Own Profile ───────────────────────────────────────────────────────────────
router.get('/me', getMe);
router.patch('/me', updateMe);
router.delete('/me', deleteMe);
router.post('/me/avatar', avatarUpload.single('avatar'), uploadAvatar);
router.get('/me/dashboard', getDashboard);

// ─── Peer Discovery ────────────────────────────────────────────────────────────
router.get('/discover', discoverUsers);

// ─── Connections ───────────────────────────────────────────────────────────────
// The listing MUST be registered before /:id or "connections" matches as an id.
router.get('/connections', listUserConnections);
router.post('/:id/connect', sendConnection);
router.patch('/connections/:id', respondConnection);

// ─── Public Profile ────────────────────────────────────────────────────────────
router.get('/:id', getUserProfile);

export default router;
