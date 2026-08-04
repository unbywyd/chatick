import { gzipSync } from 'node:zlib'
import { and, eq } from 'drizzle-orm'
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'
import { db } from '../db/client.js'
import { companies, companyMembers, users } from '../db/schema.js'
import { exportCompany } from './backup.js'
import { companyStorageFor, type ResolvedStorage } from './s3.js'
import { sendMail } from './mail.js'
import { localeFor } from './locale.js'

// Автобэкап компании (SPEC §8.48).
//
// Бэкап был только кнопкой: нажал — получил архив. Раз в сутки её никто не
// нажимает, а вспоминают в тот день, когда данные уже потеряны.
//
// Пишем только в СВОЁ хранилище компании. Копия на нашей инфраструктуре
// бессмысленна — она погибнет вместе с оригиналом, а обещание «данные не
// пропадут» на этом и держится.

/** Сколько копий держим. Неделя — достаточно, чтобы заметить потерю и откатиться. */
const KEEP = 7
const PREFIX = 'chatick-backups'

export type BackupResult = { key: string; bytes: number; removed: number }

/**
 * Снять архив компании и положить в её хранилище, удалив лишние старые.
 *
 * Бросает — вызывающий решает, показать ошибку человеку или записать её в
 * поле компании и разослать письмо.
 */
export async function backupCompany(companyId: string): Promise<BackupResult> {
  const store = await companyStorageFor(companyId, 'backup')
  if (!store) {
    throw new Error(
      'Company has no own storage. Connect an S3/R2 bucket first — a backup on our own infrastructure would die together with the original.',
    )
  }

  const backup = await exportCompany(companyId)
  // gzip: архив компании со всей перепиской бывает крупным.
  const payload = gzipSync(Buffer.from(JSON.stringify(backup), 'utf8'))
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const key = `${PREFIX}/${companyId}/${stamp}.json.gz`

  await store.client.send(
    new PutObjectCommand({ Bucket: store.bucket, Key: key, Body: payload, ContentType: 'application/gzip' }),
  )

  return { key, bytes: payload.length, removed: await rotate(store, companyId) }
}

/**
 * Оставить KEEP последних копий, остальные удалить.
 *
 * Без ротации бакет растёт вечно, и за него однажды приходит счёт — а
 * архивы годичной давности не нужны никому.
 */
async function rotate(store: ResolvedStorage, companyId: string): Promise<number> {
  try {
    const list = await store.client.send(
      new ListObjectsV2Command({ Bucket: store.bucket, Prefix: `${PREFIX}/${companyId}/` }),
    )

    // Имя файла — метка времени, поэтому лексикографический порядок совпадает
    // с хронологическим: сортировать по LastModified не нужно.
    const keys = (list.Contents ?? []).map((o) => o.Key).filter(Boolean).sort() as string[]
    const extra = keys.slice(0, Math.max(0, keys.length - KEEP))

    for (const Key of extra) {
      await store.client.send(new DeleteObjectCommand({ Bucket: store.bucket, Key })).catch(() => {
        // Один неудалённый архив не повод считать бэкап несостоявшимся.
      })
    }
    return extra.length
  } catch (err) {
    // Ротация — уборка, а не суть операции: архив уже лежит.
    console.error(`[backup] rotation failed for ${companyId}:`, err)
    return 0
  }
}

/** Прошли ли сутки с последнего удачного бэкапа. */
const isDue = (last: Date | null) => !last || Date.now() - last.getTime() >= 24 * 3600_000

/**
 * Обход всех компаний с включённым автобэкапом. Вызывается планировщиком.
 *
 * Ошибка одной компании не должна останавливать остальные: у каждой своё
 * хранилище, и чужой протухший ключ — не наша беда.
 */
export async function runDueBackups(): Promise<void> {
  const rows = await db.query.companies.findMany({ where: eq(companies.autoBackup, true) })

  for (const c of rows) {
    if (!isDue(c.lastBackupAt)) continue
    try {
      const out = await backupCompany(c.id)
      await db
        .update(companies)
        .set({ lastBackupAt: new Date(), lastBackupError: null, backupErrorNotifiedAt: null })
        .where(eq(companies.id, c.id))
      console.log(`[backup] ${c.name}: ${out.key} (${out.bytes} bytes, removed ${out.removed})`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[backup] ${c.name} failed:`, message)
      await db.update(companies).set({ lastBackupError: message.slice(0, 500) }).where(eq(companies.id, c.id))
      // Письмо — один раз на поломку, а не каждые сутки: ежедневная жалоба на
      // одно и то же читается как спам и перестаёт работать.
      if (!c.backupErrorNotifiedAt) await notifyAdmins(c.id, c.name, message)
    }
  }
}

async function notifyAdmins(companyId: string, companyName: string, reason: string): Promise<void> {
  const admins = await db
    .select({ id: users.id, email: users.email })
    .from(companyMembers)
    .innerJoin(users, eq(users.id, companyMembers.userId))
    .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.role, 'admin')))

  const T = {
    en: {
      title: 'Automatic backup failed',
      p1: `The daily backup of ${companyName} did not go through.`,
      note: 'Check the storage settings — the bucket or its keys are most likely no longer valid. Until this is fixed there is no fresh copy of your data.',
    },
    ru: {
      title: 'Автоматический бэкап не прошёл',
      p1: `Суточный бэкап компании ${companyName} не выполнился.`,
      note: 'Проверьте настройки хранилища — скорее всего, бакет или его ключи перестали действовать. Пока это не исправлено, свежей копии данных нет.',
    },
    he: {
      title: 'הגיבוי האוטומטי נכשל',
      p1: `הגיבוי היומי של ${companyName} לא בוצע.`,
      note: 'בדקו את הגדרות האחסון — ככל הנראה הדלי או המפתחות שלו כבר אינם תקפים. עד לתיקון אין עותק עדכני של הנתונים.',
    },
  }

  for (const a of admins) {
    const lang = await localeFor({ userId: a.id, companyId })
    const s = T[lang as keyof typeof T] ?? T.en
    void sendMail({
      to: a.email,
      companyId,
      subject: s.title,
      text: `${s.p1}\n\n${reason}\n\n${s.note}`,
    })
  }

  await db.update(companies).set({ backupErrorNotifiedAt: new Date() }).where(eq(companies.id, companyId))
}
