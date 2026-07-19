import type { Request, Response } from 'express';
import { z } from 'zod';
import * as authService from '@services/auth.service';
import { ok, fail } from '@utils/response';
import asyncHandler from '@middleware/asyncHandler';

// ─── Schemas ───────────────────────────────────────────────────────────────────

const registerSchema = z.object({ email: z.string().email() });

const clientType = z.enum(['web', 'mobile']).optional();

const verifyOTPSchema = z.object({
  email: z.string().email(),
  otp:   z.string().length(6, 'OTP must be exactly 6 digits'),
  client_type: clientType,
});

/**
 * POST /auth/google accepts two shapes:
 *  - web  → `{ code, redirect_uri }`, the authorization-code exchange (original).
 *  - native mobile → `{ id_token }`, already minted by Google on the device.
 * A union rather than a second route keeps one endpoint per provider; the web
 * branch is matched first so its behaviour is bit-for-bit unchanged.
 */
const googleSchema = z.union([
  z.object({
    code:         z.string().min(1),
    redirect_uri: z.string().url(),
    client_type:  clientType,
  }),
  z.object({
    id_token:    z.string().min(1),
    client_type: clientType,
  }),
]);

const appleSchema = z.object({
  identity_token: z.string().min(1),
  full_name:      z.string().optional(),
  email:          z.string().email().optional(),
  client_type:    clientType,
});

const forgotPasswordSchema = z.object({ email: z.string().email() });

const resetPasswordSchema = z.object({
  token:        z.string().uuid(),
  new_password: z.string().min(8, 'Password must be at least 8 characters'),
});

// ─── Handlers ──────────────────────────────────────────────────────────────────

export const register = asyncHandler(async (req: Request, res: Response) => {
  const { email } = registerSchema.parse(req.body);
  const result = await authService.initiateOTPAuth(email);
  res.status(200).json(ok(result));
});

export const verifyOTP = asyncHandler(async (req: Request, res: Response) => {
  const { email, otp, client_type } = verifyOTPSchema.parse(req.body);
  const result = await authService.verifyOTPAndLogin(email, otp, res, client_type ?? 'web');
  res.status(200).json(ok(result));
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as { refresh_token?: string; client_type?: string };
  const client = body.client_type === 'mobile' ? 'mobile' : 'web';
  // Mobile sends the refresh token in the body; web uses the HttpOnly cookie.
  const rawToken = body.refresh_token ?? (req.cookies as Record<string, string>)['refresh_token'];
  if (!rawToken) {
    res.status(401).json(fail('MISSING_TOKEN', 'Refresh token not found'));
    return;
  }
  const result = await authService.rotateRefreshToken(rawToken, res, client);
  res.status(200).json(ok(result));
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as { refresh_token?: string };
  const rawToken = body.refresh_token ?? (req.cookies as Record<string, string>)['refresh_token'];
  if (rawToken) {
    await authService.revokeRefreshToken(rawToken, req.user.id);
  }
  authService.clearRefreshTokenCookie(res);
  res.status(200).json(ok({ message: 'Logged out successfully' }));
});

// Plain sync handler — nothing async here, and Express catches sync throws.
export const getGoogleAuthUrl = (_req: Request, res: Response): void => {
  const url = authService.buildGoogleAuthUrl();
  res.status(200).json(ok({ redirect_url: url }));
};

export const handleGoogleCallback = asyncHandler(async (req: Request, res: Response) => {
  const body = googleSchema.parse(req.body);
  const result =
    'id_token' in body
      ? await authService.handleGoogleIdTokenAuth(body.id_token, res, body.client_type ?? 'mobile')
      : await authService.handleGoogleAuth(
          body.code,
          body.redirect_uri,
          res,
          body.client_type ?? 'web',
        );
  res.status(200).json(ok(result));
});

export const appleAuth = asyncHandler(async (req: Request, res: Response) => {
  const { identity_token, full_name, email, client_type } = appleSchema.parse(req.body);
  const result = await authService.handleAppleAuth(
    { identityToken: identity_token, fullName: full_name, email, clientType: client_type ?? 'mobile' },
    res,
  );
  res.status(200).json(ok(result));
});

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const { email } = forgotPasswordSchema.parse(req.body);
  await authService.initiatePasswordReset(email);
  // Always return success — don't reveal if email exists
  res.status(200).json(ok({ message: 'If this email exists, a reset link has been sent' }));
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const { token, new_password } = resetPasswordSchema.parse(req.body);
  await authService.completePasswordReset(token, new_password);
  res.status(200).json(ok({ message: 'Password reset successfully' }));
});
