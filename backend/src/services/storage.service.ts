/**
 * S3 uyumlu nesne depolama (MinIO / AWS S3 / Cloudflare R2) servisi.
 * Ekran goruntuleri sunucudan gecmeden, kisa omurlu presigned URL ile
 * dogrudan bucket'a yuklenir.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

export const s3 = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  },
});

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export function extensionFor(contentType: string): string {
  return EXT_BY_CONTENT_TYPE[contentType.toLowerCase()] ?? 'bin';
}

/** screenshots/<userId>/<yyyy-mm-dd>/<sessionId>/<epoch-ms>-m<monitor>.<ext> */
export function buildStorageKey(input: {
  userId: string;
  sessionId: string;
  capturedAt: Date;
  monitorIndex: number;
  contentType: string;
}): string {
  const day = input.capturedAt.toISOString().slice(0, 10);
  const ext = extensionFor(input.contentType);
  return [
    'screenshots',
    input.userId,
    day,
    input.sessionId,
    `${input.capturedAt.getTime()}-m${input.monitorIndex}.${ext}`,
  ].join('/');
}

export async function presignPut(
  key: string,
  contentType: string,
  ttlSeconds = config.s3.presignTtl,
): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      ContentType: contentType,
      // Sunucu tarafi sifreleme (SSE-S3)
      ServerSideEncryption: 'AES256',
    }),
    { expiresIn: ttlSeconds },
  );
}

export async function presignGet(
  key: string,
  ttlSeconds = config.s3.presignTtl,
): Promise<string | null> {
  if (!key) return null;
  if (config.s3.publicBaseUrl) return `${config.s3.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }), {
    expiresIn: ttlSeconds,
  });
}

export async function headObject(key: string): Promise<{ size: number; contentType?: string } | null> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: key }));
    return { size: Number(res.ContentLength ?? 0), contentType: res.ContentType };
  } catch {
    return null;
  }
}

export async function deleteObject(key: string): Promise<void> {
  if (!key) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
  } catch (err) {
    // Gizlilik protokolunde DB kaydi her kosulda silinmis sayilir; S3 hatasi loglanir.
    console.warn('[storage] nesne silinemedi:', (err as Error).message);
  }
}
