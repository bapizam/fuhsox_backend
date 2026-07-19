/**
 * Successful response wrapper.
 * Usage: res.status(200).json(ok({ user, accessToken }))
 */
export function ok<T>(data: T) {
  return {
    success: true as const,
    data,
  };
}

/**
 * Error response wrapper.
 * Usage: res.status(400).json(fail('INVALID_OTP', 'OTP is incorrect'))
 */
export function fail(code: string, message: string, details?: unknown) {
  return {
    success: false as const,
    data: null,
    error: {
      code,
      message,
      ...(details !== undefined && { details }),
    },
  };
}

/**
 * Paginated response wrapper.
 */
export function paginated<T>(
  items: T[],
  total: number,
  page: number,
  limit: number,
) {
  return ok({
    items,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore: page * limit < total,
    },
  });
}

// ─── API Error Codes ───────────────────────────────────────────────────────────
export const API_ERRORS = {
  MISSING_TOKEN:     { code: 'MISSING_TOKEN',     http: 401 },
  TOKEN_EXPIRED:     { code: 'TOKEN_EXPIRED',     http: 401 },
  INVALID_TOKEN:     { code: 'INVALID_TOKEN',     http: 401 },
  FORBIDDEN:         { code: 'FORBIDDEN',         http: 403 },
  DOMAIN_NOT_ALLOWED:{ code: 'DOMAIN_NOT_ALLOWED',http: 403 },
  NO_INSTITUTION:    { code: 'NO_INSTITUTION',    http: 403 },
  NOT_FOUND:         { code: 'NOT_FOUND',         http: 404 },
  CONFLICT:          { code: 'CONFLICT',          http: 409 },
  INVALID_OTP:       { code: 'INVALID_OTP',       http: 400 },
  OTP_EXPIRED:       { code: 'OTP_EXPIRED',       http: 400 },
  OTP_LOCKED:        { code: 'OTP_LOCKED',        http: 429 },
  AI_LIMIT_REACHED:  { code: 'AI_LIMIT_REACHED',  http: 429 },
  RATE_LIMITED:      { code: 'RATE_LIMITED',      http: 429 },
  VALIDATION_ERROR:  { code: 'VALIDATION_ERROR',  http: 422 },
  INTERNAL_ERROR:    { code: 'INTERNAL_ERROR',    http: 500 },
} as const;
