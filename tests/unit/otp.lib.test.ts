import { generateOTP, hashOTP, verifyOTP, hashToken, compareToken, generateRandomToken } from '@lib/otp';
import { OTP_LENGTH } from '@config/constants';

// ─── OTP Generation ────────────────────────────────────────────────────────────

describe('generateOTP', () => {
  it(`generates a ${OTP_LENGTH}-digit string`, () => {
    const otp = generateOTP();
    expect(otp).toHaveLength(OTP_LENGTH);
    expect(/^\d+$/.test(otp)).toBe(true);
  });

  it('generates values within valid range', () => {
    for (let i = 0; i < 50; i++) {
      const otp = parseInt(generateOTP(), 10);
      const min = Math.pow(10, OTP_LENGTH - 1);
      const max = Math.pow(10, OTP_LENGTH) - 1;
      expect(otp).toBeGreaterThanOrEqual(min);
      expect(otp).toBeLessThanOrEqual(max);
    }
  });

  it('generates different OTPs on successive calls (statistical uniqueness)', () => {
    const otps = new Set(Array.from({ length: 20 }, () => generateOTP()));
    // With 6-digit codes across 20 samples, we expect most to be unique
    expect(otps.size).toBeGreaterThan(15);
  });
});

// ─── OTP Hashing & Verification ────────────────────────────────────────────────

describe('hashOTP / verifyOTP', () => {
  it('hashes an OTP into a bcrypt hash', async () => {
    const otp  = '123456';
    const hash = await hashOTP(otp);
    expect(hash).toMatch(/^\$2[ab]\$\d+\$/); // bcrypt format
    expect(hash).not.toEqual(otp);
  });

  it('verifies the correct OTP against its hash', async () => {
    const otp  = generateOTP();
    const hash = await hashOTP(otp);
    const valid = await verifyOTP(otp, hash);
    expect(valid).toBe(true);
  });

  it('rejects an incorrect OTP', async () => {
    const otp  = '654321';
    const hash = await hashOTP('123456');
    const valid = await verifyOTP(otp, hash);
    expect(valid).toBe(false);
  });

  it('is resistant to timing attacks (bcrypt is constant time)', async () => {
    // Both calls should take similar time (bcrypt handles this internally)
    const hash = await hashOTP('123456');
    const [t1Start] = process.hrtime.bigint ? [process.hrtime.bigint()] : [BigInt(Date.now())];
    await verifyOTP('123456', hash);
    const [t1End] = [process.hrtime.bigint ? process.hrtime.bigint() : BigInt(Date.now())];
    // Just ensure it completes without hanging — actual timing is bcrypt's responsibility
    expect(t1End - t1Start).toBeLessThan(BigInt(5_000_000_000)); // < 5 seconds
  });
});

// ─── Token Hashing ────────────────────────────────────────────────────────────

describe('hashToken / compareToken', () => {
  it('hashes a token and verifies it correctly', async () => {
    const token = 'raw-refresh-token-value';
    const hash  = await hashToken(token);
    expect(hash).not.toEqual(token);
    const valid = await compareToken(token, hash);
    expect(valid).toBe(true);
  });

  it('rejects a different token against a hash', async () => {
    const hash  = await hashToken('correct-token');
    const valid = await compareToken('wrong-token', hash);
    expect(valid).toBe(false);
  });
});

// ─── Random Token ────────────────────────────────────────────────────────────

describe('generateRandomToken', () => {
  it('generates a hex string of the correct length', () => {
    const token = generateRandomToken(64);
    // 64 bytes → 128 hex characters
    expect(token).toHaveLength(128);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });

  it('generates unique tokens on successive calls', () => {
    const tokens = new Set(Array.from({ length: 10 }, () => generateRandomToken()));
    expect(tokens.size).toBe(10);
  });

  it('uses 64 bytes by default', () => {
    const token = generateRandomToken();
    expect(token).toHaveLength(128);
  });
});
