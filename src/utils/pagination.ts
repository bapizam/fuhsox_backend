import { PAGINATION } from '@config/constants';

export interface OffsetPaginationParams {
  page: number;
  limit: number;
}

export interface OffsetPaginationResult {
  skip: number;
  take: number;
  page: number;
  limit: number;
}

/**
 * Compute Prisma skip/take from page/limit query params.
 */
export function offsetPagination(params: OffsetPaginationParams): OffsetPaginationResult {
  const page = Math.max(1, params.page);
  const limit = Math.min(params.limit, PAGINATION.MAX_LIMIT);
  const skip = (page - 1) * limit;
  return { skip, take: limit, page, limit };
}

/**
 * Build a paginated response structure from data + count.
 */
export function buildPaginationMeta(total: number, page: number, limit: number) {
  return {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    hasMore: page * limit < total,
  };
}

/**
 * Parse page/limit from query params with safe defaults.
 */
export function parsePaginationQuery(
  query: Record<string, unknown>,
  defaultLimit = PAGINATION.DEFAULT_LIMIT,
) {
  const page = Math.max(1, Number(query['page']) || 1);
  const limit = Math.min(
    Math.max(1, Number(query['limit']) || defaultLimit),
    PAGINATION.MAX_LIMIT,
  );
  return { page, limit };
}
