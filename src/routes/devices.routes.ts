import { Router } from 'express';
import authenticate from '@middleware/authenticate';
import { registerPushToken, deregisterPushToken } from '@controllers/device.controller';

const router = Router();

// All device routes require an authenticated user.
router.use(authenticate);

// POST   /api/v1/devices/register-push-token  — register/refresh an Expo push token
router.post('/register-push-token', registerPushToken);

// DELETE /api/v1/devices/push-token           — deregister (logout / opt-out)
router.delete('/push-token', deregisterPushToken);

export default router;
