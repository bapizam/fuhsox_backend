import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '@config/env';
import { generateUUID } from './otp';

// ─── S3 Client ────────────────────────────────────────────────────────────────

export const s3Client = new S3Client({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});

// ─── Upload ───────────────────────────────────────────────────────────────────

export interface UploadResult {
  key: string;
  url: string;
}

export async function uploadToS3(
  buffer: Buffer,
  key: string,
  contentType: string,
): Promise<UploadResult> {
  const command = new PutObjectCommand({
    Bucket: env.AWS_S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });

  await s3Client.send(command);

  const url = `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
  return { key, url };
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
    Bucket: env.AWS_S3_BUCKET,
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
    Bucket: env.AWS_S3_BUCKET,
    Key: key,
  });
  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}

// ─── Key Extractor ────────────────────────────────────────────────────────────

export function extractKeyFromUrl(url: string): string {
  const bucketDomain = `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/`;
  return url.replace(bucketDomain, '');
}
