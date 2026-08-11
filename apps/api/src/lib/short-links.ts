import { and, eq } from 'drizzle-orm'
import { customAlphabet } from 'nanoid'
import { db } from '../db/client.js'
import { shortLinks } from '../db/schema.js'

/**
 * Короткие ссылки на сущности: chatick.com/t-AbC12.
 *
 * Зачем: адрес задачи — это 90 символов с двумя nanoid'ами
 * (/#/c/UefX2Rs…/p/6Tqg5…/tasks/EVQUH…). Такую ссылку неудобно слать в чат,
 * она переносится по строкам и в половине мессенджеров ломается на «#».
 *
 * Что это НЕ делает: не открывает доступ. Ссылка ведёт на обычный адрес
 * приложения, и дальше решают права. Публичный доступ — отдельный механизм
 * (shares), с отзывом и сроком жизни.
 */

/**
 * Алфавит без «похожих» символов: 0/O, 1/l/I убраны.
 *
 * Ссылку диктуют голосом и переписывают с экрана — «l» и «1» в таком коде
 * означают гарантированную опечатку и «страница не найдена» вместо задачи.
 */
const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'

/**
 * Пять символов — это 55^5 ≈ 500 млн комбинаций на тип сущности.
 *
 * Коллизии решаются повтором, а не длиной: при нынешних объёмах (сотни задач)
 * шанс совпадения ничтожен, а короткий код и есть смысл затеи. Если когда-то
 * станет тесно, длина поднимется здесь одной цифрой — уже выданные ссылки
 * продолжат работать, они лежат в таблице.
 */
const makeCode = customAlphabet(ALPHABET, 5)

/**
 * Префиксы в адресе. Человек по ним понимает, куда его зовут, ещё не открыв
 * ссылку, — «t-» задача, «f-» файл.
 *
 * Разбирается ссылка всё равно по таблице: префикс лишь подсказка, а не
 * источник истины. Иначе переименование типа ломало бы выданные ссылки.
 */
export const SHORT_PREFIX: Record<string, string> = {
  task: 't',
  file: 'f',
  note: 'n',
  resource: 'r',
  message: 'm',
  document: 'd',
  project: 'p',
}

const BY_PREFIX = new Map(Object.entries(SHORT_PREFIX).map(([type, p]) => [p, type]))

/** Разбирает «t-AbC12» на тип и код. null — не наш формат. */
export function parseShortPath(raw: string): { type: string; code: string } | null {
  const m = /^([a-z])-([2-9a-zA-Z]{4,12})$/.exec(raw.trim())
  if (!m) return null
  const type = BY_PREFIX.get(m[1]!)
  return type ? { type, code: m[2]! } : null
}

/**
 * Короткий код сущности: существующий или новый.
 *
 * Повторный вызов возвращает тот же код — у задачи один короткий адрес.
 * Иначе в переписке две ссылки на одну задачу выглядели бы как две разные.
 */
export async function shortCodeFor(
  entityType: string,
  entityId: string,
  projectId: string,
  userId: string | null,
): Promise<string | null> {
  const prefix = SHORT_PREFIX[entityType]
  if (!prefix) return null

  const existing = await db.query.shortLinks.findFirst({
    where: and(eq(shortLinks.entityType, entityType), eq(shortLinks.entityId, entityId)),
  })
  if (existing) return `${prefix}-${existing.code}`

  // Коллизия кода маловероятна, но не невозможна: ловим её вставкой, а не
  // предварительной проверкой — между «проверил» и «вставил» успевает
  // вклиниться параллельный запрос.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeCode()
    try {
      await db.insert(shortLinks).values({ code, entityType, entityId, projectId, createdById: userId })
      return `${prefix}-${code}`
    } catch {
      // Уникальный индекс сработал. Либо код занят — берём новый, либо ссылку
      // на эту сущность параллельно создал кто-то ещё: тогда она уже есть.
      const now = await db.query.shortLinks.findFirst({
        where: and(eq(shortLinks.entityType, entityType), eq(shortLinks.entityId, entityId)),
      })
      if (now) return `${prefix}-${now.code}`
    }
  }
  // Пять попыток подряд не удались — что-то не так с базой, а не с удачей.
  return null
}

/** Куда ведёт код: сущность и её проект. null — ссылки нет. */
export async function resolveShortCode(type: string, code: string) {
  const row = await db.query.shortLinks.findFirst({
    where: and(eq(shortLinks.entityType, type), eq(shortLinks.code, code)),
  })
  return row ?? null
}
