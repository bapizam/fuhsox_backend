import prisma from '@config/database';
import { AppError } from '@typings/models';
import logger from '@lib/logger';

// ─── Create Article ────────────────────────────────────────────────────────────

export async function createArticle(params: {
  institutionId:  string;
  createdBy:      string;
  title:          string;
  category:       string;
  htmlBody:       string;
  coverImageUrl?: string;
  scheduledFor?:  Date | null;
  isPinned?:      boolean;
}) {
  const status = params.scheduledFor && params.scheduledFor > new Date()
    ? 'scheduled'
    : 'draft';

  const article = await prisma.newsArticle.create({
    data: {
      institution_id:  params.institutionId,
      created_by:      params.createdBy,
      title:           params.title,
      category:        params.category,
      html_body:       params.htmlBody,
      cover_image_url: params.coverImageUrl ?? null,
      scheduled_for:   params.scheduledFor ?? null,
      is_pinned:       params.isPinned ?? false,
      status,
    },
  });

  logger.info({ articleId: article.id, institutionId: params.institutionId }, 'News article created');

  return article;
}

// ─── Publish Article ───────────────────────────────────────────────────────────

export async function publishArticle(articleId: string, institutionId: string) {
  const article = await prisma.newsArticle.findFirst({
    where: { id: articleId, institution_id: institutionId },
  });

  if (!article) throw new AppError(404, 'NOT_FOUND', 'Article not found');
  if (article.status === 'published') throw new AppError(409, 'CONFLICT', 'Article is already published');

  return prisma.newsArticle.update({
    where: { id: articleId },
    data:  { status: 'published', published_at: new Date() },
  });
}

// ─── List Articles (Admin) ─────────────────────────────────────────────────────

export async function listArticles(
  institutionId: string,
  filter: {
    status?:   'draft' | 'scheduled' | 'published';
    category?: string;
    page:      number;
    limit:     number;
  },
) {
  const skip = (filter.page - 1) * filter.limit;

  const where: Record<string, unknown> = {
    institution_id: institutionId,
    ...(filter.status   && { status:   filter.status }),
    ...(filter.category && { category: filter.category }),
  };

  const [articles, total] = await Promise.all([
    prisma.newsArticle.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip,
      take:    filter.limit,
    }),
    prisma.newsArticle.count({ where }),
  ]);

  return {
    articles,
    pagination: { total, page: filter.page, limit: filter.limit, totalPages: Math.ceil(total / filter.limit), hasMore: filter.page * filter.limit < total },
  };
}

// ─── Update Article ────────────────────────────────────────────────────────────

export async function updateArticle(
  articleId:     string,
  institutionId: string,
  data: Partial<{
    title:           string;
    category:        string;
    html_body:       string;
    cover_image_url: string;
    is_pinned:       boolean;
    scheduled_for:   Date | null;
  }>,
) {
  const article = await prisma.newsArticle.findFirst({
    where: { id: articleId, institution_id: institutionId },
  });

  if (!article) throw new AppError(404, 'NOT_FOUND', 'Article not found');

  return prisma.newsArticle.update({ where: { id: articleId }, data });
}

// ─── Toggle Pin ────────────────────────────────────────────────────────────────

export async function togglePin(articleId: string, institutionId: string) {
  const article = await prisma.newsArticle.findFirst({
    where: { id: articleId, institution_id: institutionId },
  });

  if (!article) throw new AppError(404, 'NOT_FOUND', 'Article not found');

  return prisma.newsArticle.update({
    where: { id: articleId },
    data:  { is_pinned: !article.is_pinned },
  });
}

// ─── Process Scheduled Articles (called from cron) ───────────────────────────

export async function processScheduledArticles(): Promise<number> {
  const now = new Date();

  const dueArticles = await prisma.newsArticle.findMany({
    where: {
      status:        'scheduled',
      scheduled_for: { lte: now },
    },
  });

  let published = 0;
  for (const article of dueArticles) {
    try {
      await publishArticle(article.id, article.institution_id);
      published++;
    } catch (err) {
      logger.error({ err, articleId: article.id }, 'Failed to auto-publish scheduled article');
    }
  }

  return published;
}

export const newsService = {
  createArticle,
  publishArticle,
  listArticles,
  updateArticle,
  togglePin,
  processScheduledArticles,
};
