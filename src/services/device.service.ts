import prisma from '@config/database';

/**
 * Registers (or refreshes) an Expo push token for a user's device.
 * Tokens are unique per device registration; re-registering updates ownership
 * and bumps last_active_at so the future push worker can prune stale rows.
 */
export async function registerPushToken(
  userId: string,
  expoPushToken: string,
  platform: 'ios' | 'android',
) {
  return prisma.devicePushToken.upsert({
    where:  { expo_push_token: expoPushToken },
    create: { user_id: userId, expo_push_token: expoPushToken, platform },
    update: { user_id: userId, platform, last_active_at: new Date() },
  });
}

export async function removePushToken(userId: string, expoPushToken: string): Promise<void> {
  await prisma.devicePushToken.deleteMany({
    where: { user_id: userId, expo_push_token: expoPushToken },
  });
}

export const deviceService = { registerPushToken, removePushToken };
