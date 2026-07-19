import type { Request, Response } from 'express';
import { z } from 'zod';
import { deviceService } from '@services/device.service';
import { ok } from '@utils/response';
import asyncHandler from '@middleware/asyncHandler';

const registerSchema = z.object({
  expo_push_token: z.string().min(1),
  platform:        z.enum(['ios', 'android']),
});

const deregisterSchema = z.object({
  expo_push_token: z.string().min(1),
});

// POST /api/v1/devices/register-push-token
export const registerPushToken = asyncHandler(async (req: Request, res: Response) => {
  const { expo_push_token, platform } = registerSchema.parse(req.body);
  await deviceService.registerPushToken(req.user.id, expo_push_token, platform);
  res.status(200).json(ok({ message: 'Push token registered' }));
});

// DELETE /api/v1/devices/push-token
export const deregisterPushToken = asyncHandler(async (req: Request, res: Response) => {
  const { expo_push_token } = deregisterSchema.parse(req.body);
  await deviceService.removePushToken(req.user.id, expo_push_token);
  res.status(200).json(ok({ message: 'Push token removed' }));
});
