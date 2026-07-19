import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import type { Response } from 'express';
import prisma from '@config/database';
import { env } from '@config/env';
import {
  generateOTP,
  hashOTP,
  verifyOTP,
  hashToken,
  compareToken,
  generateRandomToken,
} from '@lib/otp';
import { emailQueue } from '@jobs/queues';
import { AppError, type AuthResult, type SafeUser, type JWTPayload, type Institution } from '@typings/models';
import {
  OTP_EXPIRY_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_LOCKOUT_MINUTES,
  REFRESH_TOKEN_BYTES,
  REDIS_KEYS,
  TTL,
} from '@config/constants';
import { set as redisSet, del as redisDel, get as redisGet } from '@lib/redis';
import logger from '@lib/logger';

// ─── Google OAuth Client ───────────────────────────────────────────────────────

const oauthClient = new OAuth2Client(
  env.GOOGLE_CLIENT_ID,
  env.GOOGLE_CLIENT_SECRET,
);

// ─── Institution Lookup ────────────────────────────────────────────────────────

export async function findInstitutionByEmailDomain(email: string) {
  const domain = email.split('@')[1];
  if (!domain) return null;

  const institution = await prisma.institution.findFirst({
    where: {
      email_domains: { has: domain },
    },
  });

  return institution;
}

// ─── OTP Flow ─────────────────────────────────────────────────────────────────

export async function initiateOTPAuth(email: string): Promise<{ message: string }> {
  const institution = await findInstitutionByEmailDomain(email);
  if (!institution) {
    throw new AppError(403, 'DOMAIN_NOT_ALLOWED', 'Email domain not associated with any institution');
  }

  // Check if user exists
  const user = await prisma.user.findUnique({ where: { email } });

  // Generate OTP
  const otp = generateOTP();
  const otpHash = await hashOTP(otp);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  // Invalidate any previous unused OTPs for this email
  await prisma.oTPRequest.updateMany({
    where: { email, used_at: null },
    data: { used_at: new Date() }, // mark as used (expired early)
  });

  // Create new OTP request
  await prisma.oTPRequest.create({
    data: {
      user_id:   user?.id ?? null,
      email,
      otp_hash:  otpHash,
      purpose:   'login',
      expires_at: expiresAt,
    },
  });

  // Enqueue OTP email
  await emailQueue.add('send', {
    type:     'otp',
    to:       email,
    subject:  'Your FuhsoX verification code',
    template: 'otp',
    data: {
      otp_code:         otp,
      expiry_minutes:   OTP_EXPIRY_MINUTES,
      institution_name: institution.name,
    },
  });

  logger.info({ email }, 'OTP sent');

  // Always return same message regardless of new/returning user
  return { message: 'OTP sent to your email' };
}

export async function verifyOTPAndLogin(
  email: string,
  otp: string,
  res: Response,
  clientType: ClientType = 'web',
): Promise<AuthResult> {
  // Find the latest non-used OTP request
  const otpRequest = await prisma.oTPRequest.findFirst({
    where: {
      email,
      used_at:  null,
      expires_at: { gt: new Date() },
    },
    orderBy: { created_at: 'desc' },
  });

  if (!otpRequest) {
    throw new AppError(400, 'OTP_EXPIRED', 'OTP has expired or does not exist');
  }

  // Check lockout
  if (otpRequest.locked_until && otpRequest.locked_until > new Date()) {
    const minutesLeft = Math.ceil(
      (otpRequest.locked_until.getTime() - Date.now()) / 60000,
    );
    throw new AppError(
      429,
      'OTP_LOCKED',
      `Too many failed attempts. Try again in ${minutesLeft} minutes.`,
    );
  }

  // Verify OTP
  const isValid = await verifyOTP(otp, otpRequest.otp_hash);

  if (!isValid) {
    const newAttempts = otpRequest.attempts + 1;
    const shouldLock = newAttempts >= OTP_MAX_ATTEMPTS;

    await prisma.oTPRequest.update({
      where: { id: otpRequest.id },
      data: {
        attempts:    newAttempts,
        locked_until: shouldLock
          ? new Date(Date.now() + OTP_LOCKOUT_MINUTES * 60 * 1000)
          : undefined,
      },
    });

    if (shouldLock) {
      throw new AppError(429, 'OTP_LOCKED', 'Too many failed attempts. Account locked for 30 minutes.');
    }

    throw new AppError(400, 'INVALID_OTP', `Invalid OTP code. ${OTP_MAX_ATTEMPTS - newAttempts} attempts remaining.`);
  }

  // Mark OTP as used
  await prisma.oTPRequest.update({
    where: { id: otpRequest.id },
    data:  { used_at: new Date() },
  });

  // Find or create institution
  const institution = await findInstitutionByEmailDomain(email);
  if (!institution) {
    throw new AppError(403, 'DOMAIN_NOT_ALLOWED', 'Email domain not associated with any institution');
  }

  // Find or create user
  let user = await prisma.user.findUnique({ where: { email } });
  const isNewUser = user === null;
  if (!user) {
    user = await prisma.user.create({
      data: {
        institution_id: institution.id,
        email,
        auth_provider:  'email_otp',
        email_verified: true,
        last_active_at: new Date(),
      },
    });
  } else {
    await prisma.user.update({
      where: { id: user.id },
      data:  { last_active_at: new Date(), email_verified: true },
    });
  }

  return respondAuth(user, institution, clientType, isNewUser, res);
}

// ─── Google OAuth ──────────────────────────────────────────────────────────────

export async function handleGoogleAuth(
  code: string,
  redirectUri: string,
  res: Response,
  clientType: ClientType = 'web',
): Promise<AuthResult> {
  const { tokens } = await oauthClient.getToken({ code, redirect_uri: redirectUri });

  if (!tokens.id_token) {
    throw new AppError(400, 'INVALID_TOKEN', 'Failed to obtain Google ID token');
  }

  const ticket = await oauthClient.verifyIdToken({
    idToken:  tokens.id_token,
    audience: env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (!payload) {
    throw new AppError(400, 'INVALID_TOKEN', 'Failed to verify Google ID token');
  }

  return upsertGoogleUser(payload, clientType, res);
}

/**
 * Native Google Sign-In (mobile). The device performs the whole OAuth dance
 * itself and hands us an id_token whose audience is the **iOS or Android**
 * client ID — never the web one — so `handleGoogleAuth`'s single-audience check
 * would reject it. Verifying against the array of every client ID we own is the
 * additive counterpart, leaving the web authorization-code path untouched.
 */
export async function handleGoogleIdTokenAuth(
  idToken: string,
  res: Response,
  clientType: ClientType = 'mobile',
): Promise<AuthResult> {
  const audience = [
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_IOS_CLIENT_ID,
    env.GOOGLE_ANDROID_CLIENT_ID,
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);

  if (audience.length === 0) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Google Sign-In is not configured on the server');
  }

  let payload;
  try {
    const ticket = await oauthClient.verifyIdToken({ idToken, audience });
    payload = ticket.getPayload();
  } catch {
    throw new AppError(401, 'INVALID_TOKEN', 'Google ID token verification failed');
  }

  if (!payload) {
    throw new AppError(400, 'INVALID_TOKEN', 'Failed to verify Google ID token');
  }

  return upsertGoogleUser(payload, clientType, res);
}

/**
 * Shared tail of both Google paths: domain-gate the verified email, then create
 * or link the user. Callers must have verified the token first.
 */
async function upsertGoogleUser(
  payload: TokenPayload,
  clientType: ClientType,
  res: Response,
): Promise<AuthResult> {
  const email = payload.email;
  if (!email) {
    throw new AppError(400, 'INVALID_TOKEN', 'Google account has no email address');
  }
  const googleId  = payload.sub;
  const name      = payload.name;
  const avatarUrl = payload.picture;

  // Validate domain
  const institution = await findInstitutionByEmailDomain(email);
  if (!institution) {
    throw new AppError(403, 'DOMAIN_NOT_ALLOWED', 'Your email domain is not associated with any institution');
  }

  // Upsert user
  let user = await prisma.user.findFirst({
    where: { OR: [{ google_id: googleId }, { email }] },
  });
  const isNewUser = user === null;

  if (!user) {
    user = await prisma.user.create({
      data: {
        institution_id: institution.id,
        email,
        google_id:      googleId,
        full_name:      name,
        avatar_url:     avatarUrl,
        auth_provider:  'google',
        email_verified: true,
        last_active_at: new Date(),
      },
    });
  } else if (!user.google_id) {
    user = await prisma.user.update({
      where: { id: user.id },
      data:  { google_id: googleId, last_active_at: new Date() },
    });
  } else {
    await prisma.user.update({
      where: { id: user.id },
      data:  { last_active_at: new Date() },
    });
  }

  return respondAuth(user, institution, clientType, isNewUser, res);
}

export function buildGoogleAuthUrl(): string {
  return oauthClient.generateAuthUrl({
    access_type: 'offline',
    scope: ['openid', 'email', 'profile'],
    redirect_uri: env.GOOGLE_REDIRECT_URI,
  });
}

// ─── Apple Sign-In ───────────────────────────────────────────────────────────────

interface AppleJWK {
  kty: string;
  kid: string;
  use: string;
  alg: string;
  n:   string;
  e:   string;
}

interface AppleTokenPayload {
  iss:               string;
  aud:               string;
  sub:               string;
  email?:            string;
  email_verified?:   boolean | string;
  is_private_email?: boolean | string;
}

const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER   = 'https://appleid.apple.com';
let appleKeysCache: { keys: AppleJWK[]; fetchedAt: number } | null = null;

async function getAppleSigningKeys(): Promise<AppleJWK[]> {
  const now = Date.now();
  if (appleKeysCache && now - appleKeysCache.fetchedAt < 60 * 60 * 1000) {
    return appleKeysCache.keys;
  }
  const response = await fetch(APPLE_KEYS_URL);
  if (!response.ok) {
    throw new AppError(502, 'INTERNAL_ERROR', 'Could not fetch Apple public keys');
  }
  const data = (await response.json()) as { keys: AppleJWK[] };
  appleKeysCache = { keys: data.keys, fetchedAt: now };
  return data.keys;
}

/** Verifies an Apple identity token against Apple's JWKS (FR-01-11). */
export async function verifyAppleIdentityToken(idToken: string): Promise<AppleTokenPayload> {
  if (!env.APPLE_CLIENT_ID) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Apple Sign-In is not configured on the server');
  }

  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || typeof decoded === 'string') {
    throw new AppError(400, 'INVALID_TOKEN', 'Malformed Apple identity token');
  }

  const { kid } = decoded.header;
  const jwk = (await getAppleSigningKeys()).find((k) => k.kid === kid);
  if (!jwk) {
    throw new AppError(400, 'INVALID_TOKEN', 'Apple signing key not found for this token');
  }

  const publicKey = crypto
    .createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: 'jwk' })
    .export({ type: 'spki', format: 'pem' }) as string;

  try {
    return jwt.verify(idToken, publicKey, {
      algorithms: ['RS256'],
      issuer:     APPLE_ISSUER,
      audience:   env.APPLE_CLIENT_ID,
    }) as AppleTokenPayload;
  } catch {
    throw new AppError(401, 'INVALID_TOKEN', 'Apple identity token verification failed');
  }
}

export async function handleAppleAuth(
  input: { identityToken: string; fullName?: string; email?: string; clientType: ClientType },
  res: Response,
): Promise<AuthResult> {
  const payload = await verifyAppleIdentityToken(input.identityToken);

  const appleId = payload.sub;
  // Apple only returns the email on the FIRST authorization; the client forwards it thereafter.
  const email = payload.email ?? input.email;
  if (!email) {
    throw new AppError(400, 'INVALID_TOKEN', 'Apple did not provide an email address for this account');
  }

  const institution = await findInstitutionByEmailDomain(email);
  if (!institution) {
    throw new AppError(403, 'DOMAIN_NOT_ALLOWED', 'Your email domain is not associated with any institution');
  }

  let user = await prisma.user.findFirst({
    where: { OR: [{ apple_id: appleId }, { email }] },
  });
  const isNewUser = user === null;

  if (!user) {
    user = await prisma.user.create({
      data: {
        institution_id: institution.id,
        email,
        apple_id:       appleId,
        full_name:      input.fullName ?? null,
        auth_provider:  'apple',
        email_verified: payload.email_verified === true || payload.email_verified === 'true',
        last_active_at: new Date(),
      },
    });
  } else if (!user.apple_id) {
    user = await prisma.user.update({
      where: { id: user.id },
      data:  { apple_id: appleId, last_active_at: new Date() },
    });
  } else {
    await prisma.user.update({
      where: { id: user.id },
      data:  { last_active_at: new Date() },
    });
  }

  return respondAuth(user, institution, input.clientType, isNewUser, res);
}

// ─── Token Management ──────────────────────────────────────────────────────────

export function issueAccessToken(user: { id: string; role: string; institution_id: string }): string {
  return jwt.sign(
    {
      sub:            user.id,
      role:           user.role,
      institution_id: user.institution_id,
    } satisfies Omit<JWTPayload, 'iat' | 'exp'>,
    env.JWT_ACCESS_SECRET,
    { expiresIn: '15m' },
  );
}

export async function issueRefreshToken(userId: string): Promise<string> {
  const rawToken = generateRandomToken(REFRESH_TOKEN_BYTES);
  const tokenHash = await hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await prisma.refreshToken.create({
    data: { user_id: userId, token_hash: tokenHash, expires_at: expiresAt },
  });

  return rawToken;
}

export function setRefreshTokenCookie(res: Response, token: string): void {
  res.cookie('refresh_token', token, {
    httpOnly: true,
    secure:   env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days in ms
    path:     '/api/v1/auth',
  });
}

export function clearRefreshTokenCookie(res: Response): void {
  res.clearCookie('refresh_token', {
    httpOnly: true,
    secure:   env.NODE_ENV === 'production',
    sameSite: 'strict',
    path:     '/api/v1/auth',
  });
}

// ─── Auth Result Shaping ─────────────────────────────────────────────────────────

export type ClientType = 'web' | 'mobile';

/**
 * Issues the token pair and shapes the AuthResult. Mobile clients receive the
 * refresh token in the response body (FR-01-12); web clients receive it as an
 * HttpOnly cookie. `is_new_user` drives the mobile onboarding decision.
 */
async function respondAuth<T extends { id: string; role: string; institution_id: string }>(
  user: T,
  institution: Institution,
  clientType: ClientType,
  isNewUser: boolean,
  res: Response,
): Promise<AuthResult> {
  const accessToken = issueAccessToken(user);
  const refreshToken = await issueRefreshToken(user.id);
  const { password_hash: _pw, ...safeUser } = user as T & { password_hash?: unknown };

  if (clientType === 'mobile') {
    return {
      accessToken,
      refreshToken,
      user: safeUser as unknown as SafeUser,
      institution,
      is_new_user: isNewUser,
    };
  }

  setRefreshTokenCookie(res, refreshToken);
  return {
    accessToken,
    user: safeUser as unknown as SafeUser,
    institution,
    is_new_user: isNewUser,
  };
}

/**
 * Refresh token rotation — issues new access + refresh token.
 * Implements breach detection: if an already-revoked token is submitted,
 * ALL tokens for that user are revoked.
 */
export async function rotateRefreshToken(
  rawToken: string,
  res: Response,
  clientType: ClientType = 'web',
): Promise<{ accessToken: string; refreshToken?: string }> {
  if (!rawToken) {
    throw new AppError(401, 'MISSING_TOKEN', 'Refresh token not found');
  }

  // Get all non-expired tokens for this user
  // We need to find the matching one via bcrypt compare (no better way with bcrypt)
  const candidates = await prisma.refreshToken.findMany({
    where: {
      expires_at: { gt: new Date() },
    },
    orderBy: { created_at: 'desc' },
    take: 500, // Safety limit
  });

  let matchedToken = null;
  for (const candidate of candidates) {
    const matches = await compareToken(rawToken, candidate.token_hash);
    if (matches) {
      matchedToken = candidate;
      break;
    }
  }

  if (!matchedToken) {
    throw new AppError(401, 'INVALID_TOKEN', 'Refresh token is invalid or has expired');
  }

  // Check if this token was already revoked (breach detection)
  if (matchedToken.revoked_at !== null) {
    // BREACH DETECTED — revoke ALL tokens for this user
    await prisma.refreshToken.updateMany({
      where: { user_id: matchedToken.user_id },
      data:  { revoked_at: new Date() },
    });

    logger.warn({ userId: matchedToken.user_id }, '⚠️  Token reuse detected — all sessions revoked');
    throw new AppError(401, 'INVALID_TOKEN', 'Security breach detected. All sessions have been terminated.');
  }

  // Revoke the old token
  await prisma.refreshToken.update({
    where: { id: matchedToken.id },
    data:  { revoked_at: new Date() },
  });

  // Get the user
  const user = await prisma.user.findUnique({ where: { id: matchedToken.user_id } });
  if (!user) {
    throw new AppError(401, 'INVALID_TOKEN', 'User not found');
  }

  // Issue new tokens (rotation)
  const newAccessToken = issueAccessToken(user);
  const newRefreshToken = await issueRefreshToken(user.id);

  if (clientType === 'mobile') {
    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
  }
  setRefreshTokenCookie(res, newRefreshToken);
  return { accessToken: newAccessToken };
}

export async function revokeRefreshToken(rawToken: string, userId: string): Promise<void> {
  const candidates = await prisma.refreshToken.findMany({
    where: { user_id: userId, revoked_at: null },
  });

  for (const candidate of candidates) {
    const matches = await compareToken(rawToken, candidate.token_hash);
    if (matches) {
      await prisma.refreshToken.update({
        where: { id: candidate.id },
        data:  { revoked_at: new Date() },
      });
      break;
    }
  }
}

// ─── Password Reset ────────────────────────────────────────────────────────────

export async function initiatePasswordReset(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  // Always succeed — don't reveal if email exists
  if (!user) return;

  const token = crypto.randomUUID();
  await redisSet(REDIS_KEYS.PASSWORD_RESET(token), user.id, TTL.PASSWORD_RESET);

  const institution = await prisma.institution.findUnique({
    where: { id: user.institution_id },
  });

  await emailQueue.add('send', {
    type:     'password_reset',
    to:       email,
    subject:  'Reset your FuhsoX password',
    template: 'password-reset',
    data: {
      user_name:       user.full_name?.split(' ')[0] ?? 'Scholar',
      reset_link:      `${env.FRONTEND_URL}/auth/reset-password?token=${token}`,
      expiry_minutes:  60,
      institution_name: institution?.name ?? 'FuhsoX',
    },
  });
}

export async function completePasswordReset(token: string, newPassword: string): Promise<void> {
  const userId = await redisGet(REDIS_KEYS.PASSWORD_RESET(token));

  if (!userId) {
    throw new AppError(400, 'INVALID_TOKEN', 'Password reset token is invalid or expired');
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);

  await prisma.user.update({
    where: { id: userId },
    data:  { password_hash: passwordHash },
  });

  await redisDel(REDIS_KEYS.PASSWORD_RESET(token));

  // Revoke all refresh tokens for this user
  await prisma.refreshToken.updateMany({
    where: { user_id: userId },
    data:  { revoked_at: new Date() },
  });
}
