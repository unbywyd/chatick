import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import type { Readable } from 'node:stream'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { eq } from 'drizzle-orm'
import { env } from '../env.js'
import { db } from '../db/client.js'
import { companyBackupStorage, companyStorage, projects, projectStorage } from '../db/schema.js'
import { decrypt } from './crypto.js'

// R2: ключи старого аккаунта, файлы chatick-next живут под префиксом chatick-next/
export const S3_KEY_PREFIX = 'chatick-next'

// --- Платформенное хранилище (наш дефолт) ---
const platform = env.S3_ENDPOINT
  ? new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      credentials: { accessKeyId: env.S3_ACCESS_KEY!, secretAccessKey: env.S3_SECRET_KEY! },
    })
  : null

export function s3Client() {
  if (!platform || !env.S3_PRIVATE_BUCKET) throw new Error('S3 is not configured')
  return platform
}

export function s3Bucket() {
  if (!env.S3_PRIVATE_BUCKET) throw new Error('S3 is not configured')
  return env.S3_PRIVATE_BUCKET
}

// --- Per-project хранилище (SPEC §8.10) --------------------------------------
// Разрешает активный клиент+бакет проекта: свой S3/R2 либо платформенный.
// Кэшируем клиенты кастомных хранилищ по конфиг-отпечатку, чтобы не пересоздавать.

export type ResolvedStorage = {
  client: S3Client
  bucket: string
  keyPrefix: string // platform → S3_KEY_PREFIX; custom → '' (свой бакет целиком наш)
  isCustom: boolean
  publicUrl: string | null
}

const customCache = new Map<string, { fp: string; client: S3Client }>()

/**
 * Настройка хранилища для проекта — то есть настройка его компании.
 *
 * Уровня проекта больше нет: два места с одинаковыми полями расходились, и
 * файлы одной компании оказывались в разных бакетах. Компания одна на всех —
 * и хранилище у неё одно.
 */
async function storageConfigFor(projectId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { companyId: true },
  })
  if (!project?.companyId) return { cfg: null, scope: projectId }

  const company = await db.query.companyStorage.findFirst({
    where: eq(companyStorage.companyId, project.companyId),
  })
  // Ключ кэша — компания: один клиент S3 на всю компанию, а не на каждый проект.
  return { cfg: company ?? null, scope: project.companyId }
}

/**
 * Хранилище компании напрямую — для бэкапа, у которого нет проекта.
 * null, если компания живёт на платформенном.
 */
export async function companyStorageFor(
  companyId: string,
  /**
   * Для архивов сперва смотрим ОТДЕЛЬНОЕ хранилище бэкапов: копия имеет смысл
   * в другом аккаунте — лежащая в том же, она недоступна ровно тогда, когда
   * нужна. Не настроено — откатываемся на файловое.
   */
  purpose: 'files' | 'backup' = 'files',
): Promise<ResolvedStorage | null> {
  if (purpose === 'backup') {
    const b = await db.query.companyBackupStorage.findFirst({
      where: eq(companyBackupStorage.companyId, companyId),
    })
    if (b?.endpoint && b.bucket && b.accessKeyEncrypted && b.secretKeyEncrypted) {
      const accessKeyId = decrypt(b.accessKeyEncrypted)
      const secretAccessKey = decrypt(b.secretKeyEncrypted)
      const fp = `${b.endpoint}|${b.region}|${b.bucket}|${accessKeyId.slice(0, 6)}`
      // Свой ключ кэша: у бэкапа другой клиент, чем у файлов той же компании.
      const cacheKey = `backup:${companyId}`
      let cached = customCache.get(cacheKey)
      if (!cached || cached.fp !== fp) {
        const client = new S3Client({
          region: b.region || 'auto',
          endpoint: b.endpoint,
          credentials: { accessKeyId, secretAccessKey },
        })
        cached = { fp, client }
        customCache.set(cacheKey, cached)
      }
      return { client: cached.client, bucket: b.bucket, keyPrefix: '', isCustom: true, publicUrl: null }
    }
  }
  const cfg = await db.query.companyStorage.findFirst({ where: eq(companyStorage.companyId, companyId) })
  if (!cfg || cfg.provider !== 'custom' || !cfg.endpoint || !cfg.bucket || !cfg.accessKeyEncrypted || !cfg.secretKeyEncrypted) {
    return null
  }
  const accessKeyId = decrypt(cfg.accessKeyEncrypted)
  const secretAccessKey = decrypt(cfg.secretKeyEncrypted)
  const fp = `${cfg.endpoint}|${cfg.region}|${cfg.bucket}|${accessKeyId.slice(0, 6)}`
  let cached = customCache.get(companyId)
  if (!cached || cached.fp !== fp) {
    const client = new S3Client({ region: cfg.region || 'auto', endpoint: cfg.endpoint, credentials: { accessKeyId, secretAccessKey } })
    cached = { fp, client }
    customCache.set(companyId, cached)
  }
  return { client: cached.client, bucket: cfg.bucket, keyPrefix: '', isCustom: true, publicUrl: cfg.publicUrl ?? null }
}

export async function resolveStorage(projectId: string): Promise<ResolvedStorage> {
  const { cfg, scope } = await storageConfigFor(projectId)
  if (cfg && cfg.provider === 'custom' && cfg.endpoint && cfg.bucket && cfg.accessKeyEncrypted && cfg.secretKeyEncrypted) {
    const accessKeyId = decrypt(cfg.accessKeyEncrypted)
    const secretAccessKey = decrypt(cfg.secretKeyEncrypted)
    const fp = `${cfg.endpoint}|${cfg.region}|${cfg.bucket}|${accessKeyId.slice(0, 6)}`
    let cached = customCache.get(scope)
    if (!cached || cached.fp !== fp) {
      const client = new S3Client({ region: cfg.region || 'auto', endpoint: cfg.endpoint, credentials: { accessKeyId, secretAccessKey } })
      cached = { fp, client }
      customCache.set(scope, cached)
    }
    return { client: cached.client, bucket: cfg.bucket, keyPrefix: '', isCustom: true, publicUrl: cfg.publicUrl ?? null }
  }
  // платформенное
  return { client: s3Client(), bucket: s3Bucket(), keyPrefix: S3_KEY_PREFIX, isCustom: false, publicUrl: env.S3_PUBLIC_URL ?? null }
}

/** Хранилище проекта использует НЕ платформу (свой лимит не считаем). */
export async function isCustomStorage(projectId: string): Promise<boolean> {
  const { cfg } = await storageConfigFor(projectId)
  return Boolean(cfg && cfg.provider === 'custom' && cfg.bucket)
}

// --- Операции: принимают явный store (per-project) -----------------------------

/** Presigned GET — временная ссылка на скачивание приватного файла. */
export function presignDownload(store: ResolvedStorage, key: string, filename: string, expiresIn = 600) {
  return getSignedUrl(
    store.client,
    new GetObjectCommand({
      Bucket: store.bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    }),
    { expiresIn },
  )
}

/** Presigned GET для просмотра в браузере (inline): превью картинок, PDF во вкладке. */
export function presignView(store: ResolvedStorage, key: string, mime: string, expiresIn = 3600) {
  return getSignedUrl(
    store.client,
    new GetObjectCommand({
      Bucket: store.bucket,
      Key: key,
      ResponseContentDisposition: 'inline',
      ResponseContentType: mime,
    }),
    { expiresIn },
  )
}

export async function deleteObject(store: ResolvedStorage, key: string) {
  await store.client.send(new DeleteObjectCommand({ Bucket: store.bucket, Key: key }))
}

/** Стрим объекта (для прокси-отдачи файла через API). */
/**
 * Поток объекта из хранилища.
 *
 * range нужен аудио и видео: без частичных запросов браузер тянет файл целиком
 * и перемотка по длинной записи работает рывками либо не работает вовсе.
 */
export async function getObjectStream(
  store: ResolvedStorage,
  key: string,
  range?: string,
): Promise<{ body: Readable; contentType?: string; contentLength?: number; contentRange?: string }> {
  const res = await store.client.send(new GetObjectCommand({ Bucket: store.bucket, Key: key, Range: range }))
  return {
    body: res.Body as Readable,
    contentType: res.ContentType,
    contentLength: res.ContentLength,
    contentRange: res.ContentRange,
  }
}
