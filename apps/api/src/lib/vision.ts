import { and, desc, eq, gte, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companies, files, messages, projects } from '../db/schema.js'
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
 * Насколько назад смотрим в диалоге.
 *
 * Полчаса: картинка, показанная только что, — та самая, о которой спрашивают.
 * Вчерашнюю подтягивать нельзя, иначе «глянь» через сутки оплатит забытый
 * скриншот.
 */
const RECENT_WINDOW_MS = 30 * 60 * 1000

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

/**
 * Просьба посмотреть — либо словами, либо самим фактом отправки картинки.
 *
 * Сообщение из одного скрепыша («📎», пустой текст) — это и есть «вот,
 * смотри»: человек приложил картинку и ничего не написал, потому что и так
 * понятно. Требовать от него ещё и слов — значит заставлять угадывать
 * заклинание.
 */
export const asksToLook = (text: string): boolean => {
  const t = text.trim()
  if (!t || t === '📎') return true
  return ASK_RE.test(t)
}

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
  userId: string,
): Promise<VisionImage[]> {
  if (!asksToLook(text)) return []

  // Вижен выключен у компании — картинок не шлём вовсе.
  //
  // Не всякая модель их понимает, а та, что не понимает, отвечает ошибкой на
  // ВЕСЬ запрос: человек получит «не получилось» вместо ответа и не поймёт,
  // при чём тут скриншот. Пусть включают осознанно, зная свою модель.
  const [company] = await db
    .select({ vision: companies.llmVision })
    .from(companies)
    .innerJoin(projects, eq(projects.companyId, companies.id))
    .where(eq(projects.id, projectId))
    .limit(1)
  if (!company?.vision) return []

  /**
   * Ищем вложения текущего сообщения — и предыдущего своего, если в текущем
   * их нет.
   *
   * Люди отправляют картинку и просьбу РАЗНЫМИ сообщениями: сначала «📎», а
   * следом «посмотри, что там». Требовать, чтобы просьба была в той же
   * реплике, — значит требовать от человека знать, как мы устроены внутри.
   *
   * Ищем по АВТОРУ, а не по получателю: ответы ассистента тоже адресованы
   * человеку, и по recipientId «два последних» оказывались его репликой и
   * ответом ИИ — картинка из предыдущего сообщения в окно не попадала.
   *
   * Три последних СВОИХ: между отправкой картинки и просьбой человек успевает
   * написать что-то ещё («ну как?», «а теперь?»). Дальше не лезем — иначе
   * «глянь» через час подтянет забытый скриншот, за который ещё и заплатим.
   */
  // Берём картинки из СВЕЖИХ сообщений этого диалога — по времени, а не по
  // числу реплик.
  //
  // Считать сообщения бессмысленно: между «вот скрин» и «а теперь глянь»
  // человек напишет то одну реплику, то пять, и любое N окажется неверным.
  // А по времени граница осмысленна: картинка, показанная десять минут назад,
  // почти наверняка та самая, о которой речь; вчерашняя — почти наверняка нет.
  const since = new Date(Date.now() - RECENT_WINDOW_MS)
  const rows = await db
    .select({
      id: files.id,
      name: files.name,
      mime: files.mime,
      size: files.size,
      key: files.key,
      at: files.createdAt,
    })
    .from(files)
    .innerJoin(messages, eq(messages.id, files.messageId))
    .where(
      and(
        eq(files.projectId, projectId),
        eq(files.uploadedById, userId),
        eq(messages.mode, 'ai'),
        eq(messages.authorId, userId),
        gte(files.createdAt, since),
        isNull(files.deletedAt),
      ),
    )
    .orderBy(desc(files.createdAt))

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

/** Включён ли вижен у компании проекта — чтобы объяснить, ПОЧЕМУ не смотрим. */
export async function visionEnabled(projectId: string): Promise<boolean> {
  const [company] = await db
    .select({ vision: companies.llmVision })
    .from(companies)
    .innerJoin(projects, eq(projects.companyId, companies.id))
    .where(eq(projects.id, projectId))
    .limit(1)
  return Boolean(company?.vision)
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
