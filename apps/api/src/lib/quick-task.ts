/**
 * Быстрое создание задачи одной строкой: `сверстать шапку @Элиша #Atlas`.
 *
 * Чистый модуль: разбор строки и сопоставление имён — без базы, чтобы правила
 * проверялись тестами. Кто есть в компании и какие проекты, передаёт маршрут.
 *
 * Правила:
 *   @кто      — исполнитель (кому мяч). Нет — задача на себя: ничья задача
 *               не появляется ни в чьём «На мне».
 *   #проект   — проект. Нет — основной проект компании, или единственный, где
 *               человек состоит. Иначе спрашиваем.
 *   @"Имя Фамилия", #"Два слова" — когда в имени пробел.
 *   Остальное — название задачи.
 *
 * Неоднозначность не угадываем: «@Ал» при Алексе и Алле — список кандидатов,
 * а не задача на первого попавшегося. Ошибиться с адресатом мяча хуже, чем
 * переспросить.
 */

export interface ParsedQuick {
  title: string
  people: string[]
  projects: string[]
}

const TOKEN = /(^|\s)([@#])(?:"([^"]+)"|([^\s"]+))/gu
const TRAIL = /[.,;:!?)\]]+$/u

export function parseQuick(input: string): ParsedQuick {
  const people: string[] = []
  const projects: string[] = []
  const title = input
    .replace(TOKEN, (m: string, lead: string, sigil: string, quoted?: string, bare?: string) => {
      const value = quoted !== undefined ? quoted.trim() : (bare ?? '').replace(TRAIL, '')
      if (!value) return lead
      // «поправить баг #12» — номер, а не проект: остаётся в названии.
      if (sigil === '#' && /^\d+$/.test(value)) return m
      ;(sigil === '@' ? people : projects).push(value)
      return lead
    })
    .replace(/(^|\s)[@#](?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[\s,.;:!?]+|[\s,;:]+$/g, '')
  return { title, people, projects }
}

/** Сравниваем без регистра, ё = е, без пробелов и дефисов. */
export const norm = (s: string): string =>
  s
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[\s\-_.]+/g, '')

const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

/**
 * Скелет имени: латиницей, без гласных. Имена в профилях латиницей, а пишут
 * их по-русски — «@Элиша» должна найти Elisha, «@Алекс» — Alex, «@Артём» —
 * Artyom. Точная транслитерация не сходится («Алекс» → aleks), поэтому
 * сравниваем согласные: lsh = lsh, lx = lx, rtm = rtm. Скелет грубый, и
 * совпадения бывают, — но это последний уровень, и неоднозначность
 * спрашивается, а не угадывается.
 */
export const skeleton = (s: string): string =>
  norm(s)
    .split('')
    .map((ch) => CYR[ch] ?? ch)
    .join('')
    .replace(/kh/g, 'h')
    .replace(/ks/g, 'x')
    .replace(/[aeiouy]/g, '')

export type Match<T> = { ok: true; value: T } | { ok: false; reason: 'none' | 'ambiguous'; candidates: T[] }

const SELF = new Set(['me', 'я', 'мне', 'себе', 'אני'])

export interface Person {
  id: string
  name: string
  email: string
}

/**
 * Человек по токену. Порядок — от точного к приблизительному, и первый
 * уровень, где совпадение единственное, побеждает: «@Алекс» найдёт Алекса,
 * даже если есть Александра, а «@Ал» при обоих — спросит.
 */
export function matchPerson(token: string, people: Person[], meId: string): Match<Person> {
  const t = norm(token)
  if (SELF.has(t)) {
    const me = people.find((p) => p.id === meId)
    if (me) return { ok: true, value: me }
  }
  const levels: ((p: Person) => boolean)[] = [
    (p) => norm(p.name) === t,
    (p) => norm(p.name.split(/\s+/)[0] ?? '') === t,
    (p) => norm(p.email.split('@')[0] ?? '') === t,
    (p) => p.name.split(/\s+/).some((w) => norm(w) === t),
    (p) => t.length >= 2 && (norm(p.name).startsWith(t) || p.name.split(/\s+/).some((w) => norm(w).startsWith(t))),
    (p) => {
      const k = skeleton(token)
      return k.length >= 2 && (skeleton(p.name) === k || p.name.split(/\s+/).some((w) => skeleton(w) === k))
    },
  ]
  return firstUnique(levels, people)
}

export interface ProjectRef {
  id: string
  name: string
}

export function matchProject(token: string, projects: ProjectRef[]): Match<ProjectRef> {
  const t = norm(token)
  const levels: ((p: ProjectRef) => boolean)[] = [
    (p) => norm(p.name) === t,
    (p) => p.name.split(/\s+/).some((w) => norm(w) === t),
    (p) => t.length >= 2 && norm(p.name).startsWith(t),
    (p) => t.length >= 3 && norm(p.name).includes(t),
  ]
  return firstUnique(levels, projects)
}

function firstUnique<T>(levels: ((x: T) => boolean)[], all: T[]): Match<T> {
  for (const level of levels) {
    const hits = all.filter(level)
    if (hits.length === 1) return { ok: true, value: hits[0]! }
    if (hits.length > 1) return { ok: false, reason: 'ambiguous', candidates: hits }
  }
  return { ok: false, reason: 'none', candidates: [] }
}
