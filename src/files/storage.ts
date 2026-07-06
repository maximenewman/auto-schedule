/**
 * Tigris object storage (S3-compatible, https://t3.storage.dev). Lazy-init
 * and feature-gated: without the AWS_* env vars the app still boots and the
 * file-sync step simply reports itself unavailable.
 */
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';

let client: S3Client | null = null;

export function storageConfigured(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    process.env.BUCKET_NAME,
  );
}

function bucket(): string {
  const name = process.env.BUCKET_NAME;
  if (!name) throw new Error('BUCKET_NAME is not set');
  return name;
}

function getClient(): S3Client {
  if (client) return client;
  if (!storageConfigured()) {
    throw new Error('object storage not configured — set AWS_* and BUCKET_NAME (see .env.example)');
  }
  client = new S3Client({
    endpoint: process.env.AWS_ENDPOINT_URL_S3 ?? 'https://t3.storage.dev',
    region: process.env.AWS_REGION ?? 'auto',
  });
  return client;
}

/** Stream a body (e.g. a fetch response body) into the bucket. */
export async function putObjectStream(
  key: string,
  body: Readable | ReadableStream | Buffer,
  contentType?: string,
): Promise<void> {
  const upload = new Upload({
    client: getClient(),
    params: {
      Bucket: bucket(),
      Key: key,
      Body: body as never,
      ContentType: contentType,
    },
  });
  await upload.done();
}

/** Short-lived download URL — safe to hand to the browser. */
export async function presignGetUrl(key: string, expiresInSeconds = 300): Promise<string> {
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
    { expiresIn: expiresInSeconds },
  );
}
