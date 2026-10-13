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
 *   !срок     — !завтра, !пт, !20.10, !3д. Или в самом конце строки:
 *               «… завтра», «… до пятницы», «… к 20.10», «… by friday».
 *               День недели и дата в конце — только с предлогом: «отчёт за
 *               пятницу» остаётся названием.
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
  /** Срок, если назван; считается от «сегодня» человека в resolveDue. */
  due?: DueSpec
}

export type DueSpec = { days: number } | { weekday: number } | { day: number; month: number; year?: number }

/** Сегодня-завтра: без предлога в конце строки — это и так срок. */
const REL: Record<string, number> = {
  сегодня: 0, today: 0, היום: 0,
  завтра: 1, tomorrow: 1, מחר: 1,
  послезавтра: 2, מחרתיים: 2,
}
/** Дни недели: 0 — воскресенье. Формы, в которых их пишут после «до», «к», «в». */
const WEEKDAY: [number, RegExp][] = [
  [1, /^(пн|понедельник[аеу]?|mon|monday|שני)$/],
  [2, /^(вт|вторник[аеу]?|tue|tues|tuesday|שלישי)$/],
  [3, /^(ср|сред[аеуы]|wed|wednesday|רביעי)$/],
  [4, /^(чт|четверг[аеу]?|thu|thur|thurs|thursday|חמישי)$/],
  [5, /^(пт|пятниц[аеуы]|fri|friday|שישי)$/],
  [6, /^(сб|суббот[аеуы]|sat|saturday|שבת)$/],
  [0, /^(вс|воскресень[еяю]|sun|sunday|ראשון)$/],
]
const PREP = /^(до|к|ко|в|во|на|by|until|on|before|עד|ב)$/

/** Одно слово срока: «завтра», «пт», «20.10», «3д». null — не срок. */
export function dueWord(raw: string): DueSpec | null {
  const w = raw.toLowerCase().replace(TRAIL, '').replace(/^ב(?=\p{L})/u, '')
  if (w in REL) return { days: REL[w]! }
  for (const [d, re] of WEEKDAY) if (re.test(w)) return { weekday: d }
  const dm = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?$/.exec(w)
  if (dm) {
    const day = Number(dm[1])
    const month = Number(dm[2])
    if (day < 1 || day > 31 || month < 1 || month > 12) return null
    const y = dm[3] ? Number(dm[3]) : undefined
    return { day, month, ...(y ? { year: y < 100 ? 2000 + y : y } : {}) }
  }
  const n = /^(\d{1,3})(д|дн|дня|дней|d|days?)$/.exec(w)
  if (n) return { days: Number(n[1]) }
  return null
}

/** Срок в конце строки: последнее слово, с предлогом перед ним или без. */
function trailingDue(title: string): { title: string; due: DueSpec } | null {
  const words = title.split(' ')
  const last = words[words.length - 1]
  if (!last || words.length < 2) return null
  const spec = dueWord(last)
  if (!spec) return null
  const prev = words[words.length - 2]?.toLowerCase()
  if (prev && PREP.test(prev)) return { title: words.slice(0, -2).join(' '), due: spec }
  // Без предлога — только «сегодня/завтра/послезавтра»: «отчёт за пятницу» — название.
  if ('days' in spec && last.toLowerCase().replace(TRAIL, '') in REL) return { title: words.slice(0, -1).join(' '), due: spec }
  return null
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * Срок → дата 'YYYY-MM-DD' относительно сегодняшнего дня человека (тоже
 * 'YYYY-MM-DD', его местный). День недели — ближайший, сегодня включительно:
 * «до пятницы» в пятницу — это сегодня. Дата без года уже прошла — значит,
 * следующий год.
 */
export function resolveDue(spec: DueSpec, today: string): string {
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number]
  const base = new Date(Date.UTC(ty, tm - 1, td))
  const fmt = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  if ('days' in spec) return fmt(new Date(base.getTime() + spec.days * 86_400_000))
  if ('weekday' in spec) return fmt(new Date(base.getTime() + ((spec.weekday - base.getUTCDay() + 7) % 7) * 86_400_000))
  let d = new Date(Date.UTC(spec.year ?? ty, spec.month - 1, spec.day))
  if (!spec.year && d < base) d = new Date(Date.UTC(ty + 1, spec.month - 1, spec.day))
  return fmt(d)
}

const TOKEN = /(^|\s)([@#])(?:"([^"]+)"|([^\s"]+))/gu
const TRAIL = /[.,;:!?)\]]+$/u

export function parseQuick(input: string): ParsedQuick {
  const people: string[] = []
  const projects: string[] = []
  let due: DueSpec | undefined
  let title = input
    // !срок — в любом месте. Не срок (!важно) — остаётся в названии.
    .replace(/(^|\s)!(\S+)/gu, (m: string, lead: string, word: string) => {
      const spec = due ? null : dueWord(word)
      if (!spec) return m
      due = spec
      return lead
    })
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
  if (!due) {
    const tail = trailingDue(title)
    if (tail) {
      title = tail.title.replace(/[\s,;:]+$/g, '')
      due = tail.due
    }
  }
  return { title, people, projects, ...(due ? { due } : {}) }
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
