/**
 * Staff-written blogs for the campus feed.
 *
 * Admin-only by construction: every function takes the institution id from the
 * authenticated admin's scope, and the routes sit behind the admin guard. There
 * is no student-facing write path — students read blogs in the feed and write
 * ordinary posts, which are a different thing entirely.
 */
import prisma from '@config/database';
import { AppError } from '@typings/models';
import sanitizeHtml from 'sanitize-html';
import logger from '@lib/logger';

/** An empty/blank optional field is a MISSING value, not a value — `??` would store "". */
function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/** A blog body is authored prose — keep basic formatting, drop anything active. */
const BODY_SANITIZE = {
  allowedTags: ['p', 'br', 'strong', 'em', 'u', 'ul', 'ol', 'li', 'h2', 'h3', 'blockquote', 'a'],
  allowedAttributes: { a: ['href'] },
  allowedSchemes: ['http', 'https', 'mailto'],
};

export async function listBlogs(institutionId: string) {
  return prisma.blog.findMany({
    where:   { institution_id: institutionId },
    orderBy: { created_at: 'desc' },
  });
}

export async function createBlog(params: {
  institutionId: string;
  createdBy:     string;
  title:         string;
  body:          string;
  excerpt?:      string;
  category?:     string;
  coverImageUrl?: string;
  /** Publish immediately rather than saving a draft. */
  publish?:      boolean;
}) {
  const body = sanitizeHtml(params.body, BODY_SANITIZE);
  if (!body.trim()) {
    throw new AppError(422, 'VALIDATION_ERROR', 'The blog body is empty after sanitisation');
  }

  const blog = await prisma.blog.create({
    data: {
      institution_id:  params.institutionId,
      created_by:      params.createdBy,
      title:           params.title.trim(),
      body,
      excerpt:         emptyToNull(params.excerpt),
      category:        emptyToNull(params.category),
      cover_image_url: emptyToNull(params.coverImageUrl),
      status:          params.publish ? 'published' : 'draft',
      published_at:    params.publish ? new Date() : null,
    },
  });

  logger.info({ blogId: blog.id, published: !!params.publish }, 'Blog created');
  return blog;
}

async function ownedBlog(id: string, institutionId: string) {
  const blog = await prisma.blog.findFirst({ where: { id, institution_id: institutionId } });
  if (!blog) throw new AppError(404, 'NOT_FOUND', 'Blog not found');
  return blog;
}

export async function updateBlog(
  id: string,
  institutionId: string,
  patch: { title?: string; body?: string; excerpt?: string; category?: string; coverImageUrl?: string },
) {
  await ownedBlog(id, institutionId);

  return prisma.blog.update({
    where: { id },
    data: {
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.body !== undefined ? { body: sanitizeHtml(patch.body, BODY_SANITIZE) } : {}),
      ...(patch.excerpt !== undefined ? { excerpt: emptyToNull(patch.excerpt) } : {}),
      ...(patch.category !== undefined ? { category: emptyToNull(patch.category) } : {}),
      ...(patch.coverImageUrl !== undefined ? { cover_image_url: emptyToNull(patch.coverImageUrl) } : {}),
    },
  });
}

/** Publishing is what puts a blog in the student feed. Idempotent. */
export async function publishBlog(id: string, institutionId: string) {
  const blog = await ownedBlog(id, institutionId);
  if (blog.status === 'published') return blog;

  return prisma.blog.update({
    where: { id },
    data:  { status: 'published', published_at: new Date() },
  });
}

export async function deleteBlog(id: string, institutionId: string) {
  await ownedBlog(id, institutionId);
  await prisma.blog.delete({ where: { id } });
  return { deleted: true as const };
}

export const blogService = { listBlogs, createBlog, updateBlog, publishBlog, deleteBlog };
