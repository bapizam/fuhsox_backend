import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '@config/env';
import { generateUUID } from './otp';

// ─── Provider Resolution ──────────────────────────────────────────────────────

/**
 * Object storage speaks plain S3, so this works against AWS S3, Supabase Storage,
 * Cloudflare R2, Backblaze B2 or MinIO without code changes — only env differs.
 *
 * Storage deliberately reads its own STORAGE_* vars before falling back to the
 * AWS_* ones: `AWS_ACCESS_KEY_ID`/`_SECRET` are also consumed by SES in
 * `email.service.ts`, so re-pointing storage at another provider must not
 * silently re-credential the mailer.
 */
export const STORAGE_BUCKET = env.STORAGE_BUCKET ?? env.AWS_S3_BUCKET;

const STORAGE_REGION = env.STORAGE_REGION ?? env.AWS_REGION;

/**
 * Public URL prefix objects are served from, no trailing slash.
 *
 * On AWS the API host and the public host coincide, so it can be derived. Every
 * other provider serves reads from a different host (Supabase, for instance, uses
 * `/storage/v1/object/public/<bucket>` while the S3 API lives at
 * `/storage/v1/s3`), which is why `STORAGE_PUBLIC_BASE_URL` is mandatory whenever
 * `STORAGE_ENDPOINT` is set — enforced in `config/env.ts`.
 */
const PUBLIC_BASE_URL = (
  env.STORAGE_PUBLIC_BASE_URL ??
  `https://${STORAGE_BUCKET}.s3.${STORAGE_REGION}.amazonaws.com`
).replace(/\/+$/, '');

// ─── S3 Client ────────────────────────────────────────────────────────────────

export const s3Client = new S3Client({
  region: STORAGE_REGION,
  // Unset = real AWS, which uses virtual-hosted-style addressing. Every
  // S3-compatible provider needs the endpoint plus path-style.
  ...(env.STORAGE_ENDPOINT
    ? { endpoint: env.STORAGE_ENDPOINT, forcePathStyle: true }
    : {}),
  credentials: {
    accessKeyId: env.STORAGE_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY,
  },
});

// ─── Upload ───────────────────────────────────────────────────────────────────

export interface UploadResult {
  key: string;
  url: string;
}

/** Public URL for a stored object key. */
export function publicUrlForKey(key: string): string {
  return `${PUBLIC_BASE_URL}/${key}`;
}

export async function uploadToS3(
  buffer: Buffer,
  key: string,
  contentType: string,
): Promise<UploadResult> {
  const command = new PutObjectCommand({
    Bucket: STORAGE_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });

  await s3Client.send(command);

  return { key, url: publicUrlForKey(key) };
}

export async function uploadAvatar(
  userId: string,
  buffer: Buffer,
  mimeType: string,
): Promise<UploadResult> {
  const ext = mimeType.split('/')[1] ?? 'jpg';
  const key = `avatars/${userId}/${generateUUID()}.${ext}`;
  return uploadToS3(buffer, key, mimeType);
}

export async function uploadPDF(
  institutionId: string,
  buffer: Buffer,
  originalName: string,
): Promise<UploadResult> {
  const key = `pdfs/${institutionId}/${generateUUID()}-${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  return uploadToS3(buffer, key, 'application/pdf');
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteFromS3(key: string): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: STORAGE_BUCKET,
    Key: key,
  });
  await s3Client.send(command);
}

// ─── Pre-signed URL ───────────────────────────────────────────────────────────

export async function getPresignedUrl(
  key: string,
  expiresInSeconds: number = 3600,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: STORAGE_BUCKET,
    Key: key,
  });
  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}

// ─── Key Extractor ────────────────────────────────────────────────────────────

/**
 * Inverse of `publicUrlForKey`. Also strips the legacy AWS-shaped prefix so rows
 * written before a provider migration still resolve to a usable key.
 */
export function extractKeyFromUrl(url: string): string {
  const legacyAwsPrefix = `https://${STORAGE_BUCKET}.s3.${STORAGE_REGION}.amazonaws.com/`;
  return url
    .replace(`${PUBLIC_BASE_URL}/`, '')
    .replace(legacyAwsPrefix, '');
}
