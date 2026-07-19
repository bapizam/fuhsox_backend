import { Router } from 'express';
import * as authController from '@controllers/auth.controller';
import { otpRequestLimiter, otpVerifyLimiter, googleAuthLimiter } from '@middleware/rateLimiter';
import authenticate from '@middleware/authenticate';

const router = Router();

// ─── Email OTP Auth ────────────────────────────────────────────────────────────
// POST /api/v1/auth/register    — validate email domain, generate + send OTP
router.post('/request-otp', otpRequestLimiter, authController.register);

// POST /api/v1/auth/verify-otp  — verify OTP → access token + HttpOnly refresh cookie
router.post('/verify', otpVerifyLimiter, authController.verifyOTP);

// ─── Google OAuth ──────────────────────────────────────────────────────────────
// GET  /api/v1/auth/google      — return { redirect_url } to Google consent screen
router.get('/google', authController.getGoogleAuthUrl);

// POST /api/v1/auth/google      — exchange OAuth code for session
router.post('/google', googleAuthLimiter, authController.handleGoogleCallback);

// ─── Apple Sign-In (mobile) ──────────────────────────────────────────────────────
// POST /api/v1/auth/apple       — verify Apple identity token (JWKS) → session
router.post('/apple', googleAuthLimiter, authController.appleAuth);

// ─── Token Management ──────────────────────────────────────────────────────────
// POST /api/v1/auth/refresh     — rotate refresh token, issue new access token
router.post('/refresh', authController.refresh);

// POST /api/v1/auth/logout      — revoke refresh token, clear cookie
router.post('/logout', authenticate, authController.logout);

// ─── Password Reset ────────────────────────────────────────────────────────────
// POST /api/v1/auth/forgot-password
router.post('/forgot-password', otpRequestLimiter, authController.forgotPassword);

// POST /api/v1/auth/reset-password
router.post('/reset-password', authController.resetPassword);

export default router;
