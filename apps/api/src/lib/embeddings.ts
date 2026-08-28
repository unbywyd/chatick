import { createHash } from 'node:crypto'
import { and, asc, eq, lt, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { embeddings, embeddingQueue, notes, projects } from '../db/schema.js'
import { env } from '../env.js'
import { htmlToText } from './sanitize-html.js'
import { logAiUsage } from './ai-usage.js'

/**
 * Поиск по смыслу: превращаем текст в вектор и ищем ближайшие.
 *
 * Зачем вообще: человек спрашивает «не приходит смс», а в базе записано «SMS с
 * кодом не доставляется» — один вопрос и ни одного общего слова. Для иврита
 * это не удобство, а единственный путь: словаря иврита в Postgres нет вовсе,
 * и полнотекстовый поиск дал бы ему точное совпадение слова, без форм.
 *
 * Модель — text-embedding-3-small, 512 чисел вместо 1536: замер на живом
 * запросе показал то же качество при втрое меньшем объёме.
 */

const MODEL = 'text-embedding-3-small'
const DIMS = 512
/** Больше — обрежем: у модели свой предел, а длинный хвост всё равно ничего не добавляет к смыслу. */
const MAX_CHARS = 8000
/** Сколько раз пробуем, прежде чем отступиться: модель может отвечать отказом (лимит, кончились деньги). */
const MAX_ATTEMPTS = 5

export type EmbeddableType = 'note' | 'task' | 'task_comment' | 'document'

/** Ключ доступен — без него поиск по смыслу просто выключен, а не сломан. */
export const embeddingsEnabled = (): boolean => Boolean(env.EMBEDDING_API_KEY?.trim())

/** Отпечаток текста: правка, не менявшая его, не должна тратить деньги. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

/**
 * Текст → вектор.
 *
 * Считает ОДИН вызов на пачку: модель принимает массив, и сто заметок одним
 * запросом дешевле и быстрее, чем сто запросов.
 *
 * Траты пишем в общий журнал (ai_usage_log) с feature='embedding' — там уже
 * есть и расход по моделям, и порог с письмом. Отдельного учёта заводить не
 * пришлось.
 */
export async function embed(
  texts: string[],
  opts?: { projectId?: string | null },
): Promise<number[][] | null> {
  const key = env.EMBEDDING_API_KEY?.trim()
  if (!key || !texts.length) return null

  const input = texts.map((t) => t.slice(0, MAX_CHARS)).filter((t) => t.trim())
  if (!input.length) return null

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input, dimensions: DIMS }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Embeddings ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as {
    data: { embedding: number[]; index: number }[]
    usage?: { total_tokens?: number }
  }

  // Учёт трат. projectId нужен журналу; без него не пишем — запись без
  // проекта в отчёте всё равно негде показать.
  if (opts?.projectId && data.usage?.total_tokens) {
    void logAiUsage({
      projectId: opts.projectId,
      source: 'custom',
      model: MODEL,
      usage: { tokensIn: data.usage.total_tokens, tokensOut: 0 },
      feature: 'embedding',
    }).catch(() => {})
  }

  // Порядок ответа не гарантирован — раскладываем по index, а не по позиции.
  const out: number[][] = new Array(input.length)
  for (const row of data.data) out[row.index] = row.embedding
  return out
}

/** Вектор → строка для pgvector: '[0.1,0.2,...]'. */
const toVector = (v: number[]): string => `[${v.join(',')}]`

/**
 * Поставить сущность в очередь на пересчёт.
 *
 * Зовётся ПОСЛЕ сохранения и никогда не мешает ему: ошибку глушим, потому что
 * непроиндексированная заметка хуже, чем несохранённая, ровно наоборот.
 *
 * Повторная постановка той же сущности — не ошибка, а обычное дело: человек
 * правит заметку несколько раз подряд, и пересчитать надо один раз, последнюю
 * версию. За этим следит уникальный индекс.
 */
export async function enqueue(
  entityType: EmbeddableType,
  entityId: string,
  projectId: string | null,
): Promise<void> {
  if (!embeddingsEnabled()) return
  try {
    await db
      .insert(embeddingQueue)
      .values({ entityType, entityId, projectId })
      .onConflictDoUpdate({
        target: [embeddingQueue.entityType, embeddingQueue.entityId],
        // Сбрасываем счётчик попыток: текст изменился, и прошлая неудача
        // могла быть из-за него, а не из-за модели.
        set: { attempts: 0, lastError: null, createdAt: new Date() },
      })
  } catch (err) {
    console.warn('[embeddings] не удалось поставить в очередь:', err instanceof Error ? err.message : err)
  }
}

/** Текст сущности для индексации: заголовок и тело вместе — искать будут и по тому, и по другому. */
async function textOf(entityType: EmbeddableType, entityId: string): Promise<{ text: string; companyId: string | null; projectId: string | null } | null> {
  if (entityType === 'note') {
    const n = await db.query.notes.findFirst({ where: eq(notes.id, entityId) })
    if (!n || n.deletedAt) return null
    const tags = (JSON.parse(n.tags || '[]') as string[]).join(' ')
    // Теги и тип идут в текст: «баг» рядом с описанием помогает найти по
    // слову, которого в самом тексте нет.
    return {
      text: [n.title, tags, n.type, htmlToText(n.body)].filter(Boolean).join('\n'),
      companyId: n.companyId,
      projectId: n.projectId,
    }
  }
  return null
}

/**
 * Разобрать очередь.
 *
 * Зовётся планировщиком. Берём пачкой: один вызов модели на пачку дешевле
 * и быстрее, чем по одному.
 *
 * Отставшие после сбоя не теряются — они остаются в очереди со счётчиком
 * попыток и разбираются на следующем тике.
 */
export async function flushQueue(limit = 50): Promise<{ done: number; failed: number }> {
  if (!embeddingsEnabled()) return { done: 0, failed: 0 }

  const rows = await db
    .select()
    .from(embeddingQueue)
    .where(lt(embeddingQueue.attempts, MAX_ATTEMPTS))
    .orderBy(asc(embeddingQueue.attempts), asc(embeddingQueue.createdAt))
    .limit(limit)
  if (!rows.length) return { done: 0, failed: 0 }

  // Собираем тексты. Пропавшие сущности (удалили, пока ждали) выкидываем из
  // очереди молча: индексировать нечего, и это не ошибка.
  const items: { row: (typeof rows)[number]; text: string; companyId: string | null; hash: string }[] = []
  for (const row of rows) {
    const found = await textOf(row.entityType as EmbeddableType, row.entityId)
    if (!found || !found.text.trim()) {
      await db.delete(embeddingQueue).where(eq(embeddingQueue.id, row.id))
      await db
        .delete(embeddings)
        .where(and(eq(embeddings.entityType, row.entityType), eq(embeddings.entityId, row.entityId)))
      continue
    }
    const hash = contentHash(found.text)
    // Текст не менялся — вектор пересчитывать незачем, только снимаем из
    // очереди. Это обычный случай: заметку правят по мелочи, задевая тегами
    // или статусом, а не содержанием.
    const existing = await db.query.embeddings.findFirst({
      where: and(eq(embeddings.entityType, row.entityType), eq(embeddings.entityId, row.entityId)),
      columns: { contentHash: true, model: true },
    })
    if (existing?.contentHash === hash && existing.model === MODEL) {
      await db.delete(embeddingQueue).where(eq(embeddingQueue.id, row.id))
      continue
    }
    items.push({ row, text: found.text, companyId: found.companyId, hash })
  }
  if (!items.length) return { done: 0, failed: 0 }

  try {
    const vectors = await embed(
      items.map((i) => i.text),
      { projectId: items[0]!.row.projectId },
    )
    if (!vectors) return { done: 0, failed: 0 }

    for (let i = 0; i < items.length; i++) {
      const it = items[i]!
      const vec = vectors[i]
      if (!vec) continue
      await db
        .insert(embeddings)
        .values({
          entityType: it.row.entityType,
          entityId: it.row.entityId,
          projectId: it.row.projectId,
          companyId: it.companyId,
          embedding: sql`${toVector(vec)}::vector`,
          contentHash: it.hash,
          model: MODEL,
        })
        .onConflictDoUpdate({
          target: [embeddings.entityType, embeddings.entityId],
          set: {
            embedding: sql`${toVector(vec)}::vector`,
            contentHash: it.hash,
            model: MODEL,
            companyId: it.companyId,
            updatedAt: new Date(),
          },
        })
      await db.delete(embeddingQueue).where(eq(embeddingQueue.id, it.row.id))
    }
    return { done: items.length, failed: 0 }
  } catch (err) {
    // Пачка не удалась целиком — считаем попытку каждому. После MAX_ATTEMPTS
    // перестаём брать: модель может отвечать отказом неделями, и долбиться в
    // неё каждые пять минут бессмысленно.
    const msg = err instanceof Error ? err.message : String(err)
    for (const it of items) {
      await db
        .update(embeddingQueue)
        .set({ attempts: it.row.attempts + 1, lastError: msg.slice(0, 300) })
        .where(eq(embeddingQueue.id, it.row.id))
    }
    console.warn('[embeddings] пачка не проиндексирована:', msg)
    return { done: 0, failed: items.length }
  }
}

/**
 * Поиск по смыслу в пределах компании.
 *
 * Компания — жёсткая граница: искать по чужим данным нельзя, и фильтр стоит
 * в самом запросе, а не после выборки.
 *
 * Порог отсечения нужен: без него запрос всегда вернёт limit записей, даже
 * когда подходящих нет вовсе, — и ассистент примет самое похожее из мусора за
 * ответ.
 *
 * 0.32 — не круглое число, а замер. На базе из шести реальных записей
 * (Cardcom, SendGrid, APNs, деплой) настоящие совпадения дали 0.375–0.514,
 * а запрос «цвет кнопки в шапке», которому в базе не соответствует ничего,
 * вытянул ивритскую заметку про платежи на 0.265. Порог 0.25 такой мусор
 * пропускал.
 *
 * Ошибаться лучше в сторону «не нашёл»: ассистент, получивший пусто, скажет
 * об этом и спросит; получивший чужое — ответит уверенно и неправильно.
 */
export async function searchSemantic(opts: {
  query: string
  companyId: string
  entityTypes?: EmbeddableType[]
  limit?: number
  minScore?: number
}): Promise<{ entityType: string; entityId: string; projectId: string | null; score: number }[]> {
  if (!embeddingsEnabled() || !opts.query.trim()) return []
  const vectors = await embed([opts.query])
  const vec = vectors?.[0]
  if (!vec) return []

  const min = opts.minScore ?? 0.32
  const types = opts.entityTypes?.length ? opts.entityTypes : null
  const rows = await db
    .select({
      entityType: embeddings.entityType,
      entityId: embeddings.entityId,
      projectId: embeddings.projectId,
      score: sql<number>`1 - (${embeddings.embedding} <=> ${toVector(vec)}::vector)`,
    })
    .from(embeddings)
    .where(
      and(
        eq(embeddings.companyId, opts.companyId),
        types ? sql`${embeddings.entityType} = any(${types})` : undefined,
        sql`1 - (${embeddings.embedding} <=> ${toVector(vec)}::vector) >= ${min}`,
      ),
    )
    .orderBy(sql`${embeddings.embedding} <=> ${toVector(vec)}::vector`)
    .limit(opts.limit ?? 10)
  return rows.map((r) => ({ ...r, score: Number(r.score) }))
}

/**
 * Проиндексировать всё, что ещё не проиндексировано.
 *
 * Разовая заливка: заметки, написанные до появления поиска, иначе не нашлись
 * бы никогда. Ставит в очередь, а не считает сразу — пусть разбирает тот же
 * механизм, что и обычные правки.
 */
export async function backfill(companyId?: string): Promise<number> {
  if (!embeddingsEnabled()) return 0
  const rows = await db
    .select({ id: notes.id, projectId: notes.projectId })
    .from(notes)
    .innerJoin(projects, eq(projects.id, notes.projectId))
    .where(
      and(
        sql`${notes.deletedAt} is null`,
        companyId ? eq(projects.companyId, companyId) : undefined,
        sql`not exists (select 1 from embeddings e where e.entity_type = 'note' and e.entity_id = ${notes.id})`,
      ),
    )
  for (const r of rows) await enqueue('note', r.id, r.projectId)
  return rows.length
}

/**
 * Гибридный поиск заметок: слова И смысл.
 *
 * Одно место на оба пути — мост и ассистент внутри Chatick. Правило, выписанное
 * дважды, разъедется на первой же правке, и разойдётся молча: две ручки будут
 * отвечать по-разному на один вопрос.
 *
 * Смысловой поиск НЕ заменяет обычный, а дополняет. Точное слово ilike находит
 * надёжнее любой модели: «Cardcom» — это Cardcom, а не «что-то про платежи».
 * Зато на «оплата не проходит» ilike не найдёт ничего, а вектор найдёт.
 *
 * Порядок: сначала совпадения по словам (они точнее), затем смысловые, каждое
 * со своей оценкой. Ассистент читает сверху вниз, и то, в чём мы уверены,
 * должно стоять первым.
 *
 * Возвращает id — вызывающий сам решает, что с ними делать: у моста и у
 * ассистента разные форматы ответа.
 */
export async function searchNoteIds(opts: {
  query: string
  projectId: string
  companyId: string | null
  /** Искать по всей компании, а не только в проекте. */
  companyWide: boolean
  limit?: number
}): Promise<{ ids: string[]; semanticIds: Set<string> }> {
  const q = opts.query.trim()
  if (!q) return { ids: [], semanticIds: new Set() }

  const limit = opts.limit ?? 40

  // Слова. Ищем по заголовку, телу и тегам — как искали всегда.
  const scopeCond = opts.companyWide && opts.companyId
    ? or(eq(notes.projectId, opts.projectId), and(eq(notes.companyId, opts.companyId), eq(notes.scope, 'company')))!
    : eq(notes.projectId, opts.projectId)
  const like = `%${q}%`
  const exact = await db
    .select({ id: notes.id })
    .from(notes)
    .where(
      and(
        sql`${notes.deletedAt} is null`,
        scopeCond,
        or(sql`${notes.title} ilike ${like}`, sql`${notes.body} ilike ${like}`, sql`${notes.tags} ilike ${like}`)!,
      ),
    )
    .orderBy(sql`${notes.createdAt} desc`)
    .limit(limit)
  const ids = exact.map((r) => r.id)

  // Смысл. Только если ключ есть и в компании — вектор без companyId искать
  // негде: граница компании жёсткая.
  const semanticIds = new Set<string>()
  if (opts.companyId && embeddingsEnabled()) {
    try {
      const found = await searchSemantic({
        query: q,
        companyId: opts.companyId,
        entityTypes: ['note'],
        limit,
      })
      for (const r of found) {
        // Проектная заметка чужого проекта сюда попасть не должна: вектор
        // ограничен компанией, а видимость — проектом. Проверяем ещё раз.
        if (!opts.companyWide && r.projectId !== opts.projectId) continue
        if (!ids.includes(r.entityId)) semanticIds.add(r.entityId)
      }
    } catch (err) {
      // Модель недоступна — отдаём то, что нашли словами. Поиск, упавший
      // целиком из-за необязательной части, хуже неполного поиска.
      console.warn('[embeddings] смысловой поиск не сработал:', err instanceof Error ? err.message : err)
    }
  }

  return { ids: [...ids, ...semanticIds], semanticIds }
}
