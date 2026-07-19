import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { OTP_LENGTH } from '@config/constants';

const BCRYPT_ROUNDS = 10;

/**
 * Generate a cryptographically secure 6-digit OTP.
 */
export function generateOTP(): string {
  const min = Math.pow(10, OTP_LENGTH - 1); // 100000
  const max = Math.pow(10, OTP_LENGTH) - 1;  // 999999
  return crypto.randomInt(min, max + 1).toString();
}

/**
 * Hash an OTP using bcrypt before storing in the database.
 */
export async function hashOTP(otp: string): Promise<string> {
  return bcrypt.hash(otp, BCRYPT_ROUNDS);
}

/**
 * Verify a plain OTP against its bcrypt hash.
 */
export async function verifyOTP(otp: string, hash: string): Promise<boolean> {
  return bcrypt.compare(otp, hash);
}

/**
 * Hash a raw refresh token for secure storage.
 */
export async function hashToken(token: string): Promise<string> {
  return bcrypt.hash(token, BCRYPT_ROUNDS);
}

/**
 * Compare a raw token against its stored hash.
 */
export async function compareToken(token: string, hash: string): Promise<boolean> {
  return bcrypt.compare(token, hash);
}

/**
 * Generate a cryptographically random hex string.
 */
export function generateRandomToken(bytes: number = 64): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Generate a secure UUID v4.
 */
export function generateUUID(): string {
  return crypto.randomUUID();
}
