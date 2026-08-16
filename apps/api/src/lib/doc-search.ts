import { htmlToText } from './sanitize-html.js'

/**
 * Поиск внутри документа (SPEC §8.30).
 *
 * Чтение кусками отвечает на «дай кусок номер N», но не на «где здесь про
 * авторизацию». Спецификация в 32 тысячи символов — это восемь
 * последовательных вызовов ради одного абзаца, и модель либо тратит их, либо
 * бросает на середине и отвечает по тому, что успела прочесть.
 *
 * Ищем по ТЕКСТУ, а не по HTML, и окрестность отдаём тоже текстом: иначе
 * совпадение попадает внутрь тега, а вокруг него оказывается разметка вместо
 * слов. htmlToText — тот же, которым уже читаются куски, так что offset из
 * ответа совпадает с offset для чтения.
 *
 * По символам, а не по строкам: документ приходит из редактора одной строкой,
 * переносов в нём нет, и номер строки не значил бы ничего. Символьное
 * смещение уже используется в offset/limit — одна система координат на всё.
 */

export type DocMatch = {
  /** Смещение НАЧАЛА окрестности — годится для read_document?offset=… */
  offset: number
  /** Кусок текста вокруг совпадения. */
  text: string
}

/** Больше двадцати совпадений — это не поиск, а пересказ документа. */
const MAX_MATCHES = 20
const MIN_CONTEXT = 40
const MAX_CONTEXT = 2000
export const DEFAULT_CONTEXT = 300

export type SearchResult = {
  matches: DocMatch[]
  /** Совпадений оказалось больше потолка — показаны не все. */
  truncated: boolean
}

/**
 * Совпадения без учёта регистра, с окрестностью вокруг каждого.
 *
 * Соседние совпадения сливаются в одну окрестность: три упоминания слова в
 * одном абзаце — это один абзац, а не три почти одинаковых куска, и платить
 * за них трижды незачем.
 */
export function searchInText(text: string, query: string, context = DEFAULT_CONTEXT): SearchResult {
  const needle = query.trim().toLowerCase()
  if (!needle) return { matches: [], truncated: false }
  const pad = Math.max(MIN_CONTEXT, Math.min(MAX_CONTEXT, Math.round(context)))

  const hay = text.toLowerCase()
  const spans: [number, number][] = []

  let from = 0
  // Считаем НАЙДЕННОЕ, а не отданное: слипшиеся окрестности уменьшают число
  // кусков, и потолок по ним обрывал бы поиск позже, чем обещано.
  let hits = 0
  while (hits < MAX_MATCHES) {
    const hit = hay.indexOf(needle, from)
    if (hit === -1) break
    hits++
    const start = Math.max(0, hit - pad)
    const end = Math.min(text.length, hit + needle.length + pad)

    const last = spans[spans.length - 1]
    // Пересекается с предыдущей окрестностью — расширяем её, а не добавляем
    // почти такой же кусок рядом.
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else spans.push([start, end])

    // Сдвигаемся на длину слова, иначе «аа» в «ааа» найдётся бесконечно.
    from = hit + needle.length
  }

  const matches = spans.map(([start, end]) => ({
    offset: start,
    // Многоточия по краям — знак, что кусок вырезан, а не начало документа.
    text: (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : ''),
  }))
  // truncated считаем по НАЙДЕННОМУ, а не по отданному: слипшиеся окрестности
  // делают число кусков меньше числа совпадений.
  return { matches, truncated: hits >= MAX_MATCHES }
}

/** То же для документа в HTML: сначала в текст, потом искать. */
export function searchInDocument(html: string, query: string, context = DEFAULT_CONTEXT) {
  const text = htmlToText(html)
  const { matches, truncated } = searchInText(text, query, context)
  // total — длина ТЕКСТА, а не HTML: с ней сверяется offset, который мы
  // отдаём, и по ней же дочитывают документ обычным чтением.
  return { total: text.length, matches, truncated }
}
