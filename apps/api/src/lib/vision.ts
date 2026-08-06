import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { files } from '../db/schema.js'
import { getObjectStream, resolveStorage } from './s3.js'

/**
 * Картинки для модели (SPEC §8.51).
 *
 * Решение «смотреть или нет» принимает СЕРВЕР, а не промпт.
 *
 * Просить модель «не читай картинку, пока не попросят» бесполезно: если
 * изображение ушло в запрос, она его уже увидела — и деньги за него уже
 * потрачены. Правило, которое нельзя нарушить, лучше правила, о котором
 * просят. Поэтому картинка прикладывается к запросу только при явной просьбе
 * в тексте сообщения; иначе не отправляется вовсе.
 *
 * Только в личном диалоге с ассистентом: в общем чате картинки летят
 * постоянно и не ему.
 */

/** Форматы, которые понимают модели. Остальное (svg, pdf) не отправляем. */
const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/**
 * Потолок на картинку. Больше — модели всё равно ужимают сами, а мы бы
 * заплатили за передачу и уперлись в лимит запроса.
 */
const MAX_BYTES = 4 * 1024 * 1024
/** Сколько картинок за раз: десяток скриншотов в одном вопросе — это не вопрос. */
const MAX_IMAGES = 4

/**
 * Просят ли посмотреть картинку.
 *
 * Намеренно широкий список: человек пишет как думает — «глянь», «что тут»,
 * «посмотри скрин». Ошибиться в сторону «не посмотрел» дешевле, чем в сторону
 * «посмотрел без спроса», но и заставлять подбирать заклинание нельзя —
 * иначе человек решит, что фича не работает.
 */
const ASK_RE = new RegExp(
  [
    // русский
    'посмотр|погляд|глян|взглян|что (тут|там|на|это)|видишь|разбер|прочит|распозна|скрин|картинк|изображени|фото|макет',
    // английский
    'look at|see (this|the|image|screenshot)|what.s (in|on) (this|the)|read (this|the) (image|screenshot)|screenshot|image|picture|attached',
    // иврит
    'תסתכל|תראה|מה (יש|רואה)|צילום מסך|תמונה',
  ].join('|'),
  'i',
)

export const asksToLook = (text: string): boolean => ASK_RE.test(text)

export type VisionImage = { mediaType: string; base64: string; name: string }

/**
 * Картинки, приложенные к сообщению, — если о них попросили.
 *
 * Возвращает пустой массив, когда просьбы нет: вызывающему не нужно знать
 * правило, он просто получает или не получает картинки.
 */
export async function imagesForMessage(
  messageId: string,
  projectId: string,
  text: string,
): Promise<VisionImage[]> {
  if (!asksToLook(text)) return []

  const rows = await db
    .select()
    .from(files)
    .where(and(eq(files.messageId, messageId), eq(files.projectId, projectId), isNull(files.deletedAt)))

  const images = rows.filter((f) => SUPPORTED.has(f.mime) && Number(f.size) <= MAX_BYTES).slice(0, MAX_IMAGES)
  if (!images.length) return []

  const storage = await resolveStorage(projectId)
  const out: VisionImage[] = []
  for (const f of images) {
    try {
      const { body } = await getObjectStream(storage, f.key)
      const chunks: Buffer[] = []
      for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer))
      out.push({ mediaType: f.mime, base64: Buffer.concat(chunks).toString('base64'), name: f.name })
    } catch {
      // Не смогли достать одну — не роняем весь ответ: лучше разобрать
      // остальные и сказать про пропущенную, чем не ответить вовсе.
    }
  }
  return out
}

/** Сколько картинок приложено к сообщению — чтобы честно сказать про них. */
export async function countAttachedImages(messageId: string, projectId: string): Promise<number> {
  const rows = await db
    .select({ mime: files.mime })
    .from(files)
    .where(and(eq(files.messageId, messageId), eq(files.projectId, projectId), isNull(files.deletedAt)))
  return rows.filter((f) => SUPPORTED.has(f.mime)).length
}

export { MAX_IMAGES, MAX_BYTES, SUPPORTED }
