import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import type { Readable } from 'node:stream'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '../env.js'

// R2: ключи старого аккаунта, файлы chatick-next живут под префиксом chatick-next/
// (отдельные бакеты появятся позже — смена 2 env-переменных)
export const S3_KEY_PREFIX = 'chatick-next'

const s3 = env.S3_ENDPOINT
  ? new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      credentials: { accessKeyId: env.S3_ACCESS_KEY!, secretAccessKey: env.S3_SECRET_KEY! },
    })
  : null

export function s3Client() {
  if (!s3 || !env.S3_PRIVATE_BUCKET) throw new Error('S3 is not configured')
  return s3
}

export function s3Bucket() {
  if (!env.S3_PRIVATE_BUCKET) throw new Error('S3 is not configured')
  return env.S3_PRIVATE_BUCKET
}

/** Presigned GET — временная ссылка на скачивание приватного файла. */
export function presignDownload(key: string, filename: string, expiresIn = 600) {
  return getSignedUrl(
    s3Client(),
    new GetObjectCommand({
      Bucket: s3Bucket(),
      Key: key,
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    }),
    { expiresIn },
  )
}

/** Presigned GET для просмотра в браузере (inline): превью картинок, PDF во вкладке. */
export function presignView(key: string, mime: string, expiresIn = 3600) {
  return getSignedUrl(
    s3Client(),
    new GetObjectCommand({
      Bucket: s3Bucket(),
      Key: key,
      ResponseContentDisposition: 'inline',
      ResponseContentType: mime,
    }),
    { expiresIn },
  )
}

export async function deleteObject(key: string) {
  await s3Client().send(new DeleteObjectCommand({ Bucket: s3Bucket(), Key: key }))
}

/** Стрим объекта из R2 (для прокси-отдачи файла через API). */
export async function getObjectStream(key: string): Promise<{ body: Readable; contentType?: string; contentLength?: number }> {
  const res = await s3Client().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: key }))
  return { body: res.Body as Readable, contentType: res.ContentType, contentLength: res.ContentLength }
}
