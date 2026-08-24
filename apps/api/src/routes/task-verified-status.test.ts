import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Статус «Проверено» между «На проверке» и «Готово».
 *
 * Команда StartPlan жаловалась: «הסטטוס בבדיקה מאוד מבלבל» — review означал
 * сразу два состояния, «сдал, жду проверки» и «проверено, жду закрытия». По
 * доске не было видно, чей ход.
 *
 * Статус живёт в 13 файлах, и в трёх местах пропуск не виден сразу: молча
 * пропадают напоминания, молча ломается ассистент, молча расходятся счётчики.
 * Здесь заперты именно они.
 */

const api = (f: string) => readFileSync(join(import.meta.dirname, '..', f), 'utf8')
const app = (f: string) => readFileSync(join(import.meta.dirname, '../../../app/src', f), 'utf8')
const mcp = readFileSync(join(import.meta.dirname, '../../../mcp/src/index.ts'), 'utf8')

/** Полный список статусов в том порядке, в каком идёт работа. */
const FULL = "'todo', 'in_progress', 'review', 'verified', 'done'"
/** Список до правки — его не должно остаться нигде. */
const OLD = "'todo', 'in_progress', 'review', 'done'"

/** Сколько раз строка встречается в файле. Подстрокой, без regex: списки
 *  статусов содержат кавычки и скобки, и экранировать их каждый раз — лишний
 *  повод ошибиться в самом тесте. */
const count = (hay: string, needle: string) => hay.split(needle).length - 1

describe('статус объявлен везде', () => {
  it('в перечислении базы, между review и done', () => {
    // Порядок в pgEnum — порядок колонок на доске. В хвосте verified оказался
    // бы правее «Готово».
    expect(api('db/schema.ts')).toMatch(
      /taskStatus = pgEnum\('task_status', \['todo', 'in_progress', 'review', 'verified', 'done'\]\)/,
    )
  })

  it('миграция добавляет значение перед done', () => {
    const sql = readFileSync(join(import.meta.dirname, '../../drizzle/0086_task_verified.sql'), 'utf8')
    expect(sql).toMatch(/ADD VALUE IF NOT EXISTS 'verified' BEFORE 'done'/)
  })

  it('в трёх списках статусов', () => {
    expect(api('routes/tasks.ts'), 'серверный STATUSES').toContain(FULL)
    expect(app('components/tabs/tasks/types.ts'), 'клиентский STATUSES').toContain(FULL)
    expect(app('components/tabs/NotificationsTab.tsx'), 'список подписок').toContain(FULL)
  })
})

describe('места, где пропуск не виден сразу', () => {
  it('напоминания считают verified незакрытым', () => {
    /**
     * Самое опасное место. verified — проверку прошёл, но не закрыт: про такую
     * задачу надо напоминать. Забудешь — напоминания молча исчезнут, и никто
     * не поймёт почему.
     */
    expect(api('lib/reminders.ts')).toMatch(
      /inArray\(tasks\.status, \['todo', 'in_progress', 'review', 'verified'\]\)/,
    )
  })

  it('ассистент знает про новый статус во ВСЕХ схемах', () => {
    // Схем восемь. Пропустишь одну — ассистент не сможет поставить статус
    // именно этим инструментом и не скажет почему.
    const memory = api('lib/memory.ts')
    expect(count(memory, OLD), 'осталась схема со старым списком').toBe(0)
    expect(count(memory, FULL), 'схемы статусов не найдены').toBeGreaterThanOrEqual(8)
  })

  it('счётчики считают verified отдельно', () => {
    // Иначе цифры на доске разойдутся с реальностью: задачи есть, а в
    // статистике их нет.
    expect(api('routes/bridge.ts'), 'счётчик моста').toMatch(/verified: sql<number>`count\(\*\) filter/)
    expect(api('routes/projects.ts'), 'счётчик обзора').toMatch(/verified: sql<number>`count\(\*\) filter/)
  })
})

describe('внешние контракты', () => {
  it('мост принимает новый статус', () => {
    const bridge = api('routes/bridge.ts')
    expect(count(bridge, FULL), 'мост не знает новый статус').toBeGreaterThanOrEqual(3)
    expect(count(bridge, OLD), 'остался старый список').toBe(0)
  })

  it('MCP тоже', () => {
    expect(count(mcp, FULL), 'MCP не знает новый статус').toBeGreaterThanOrEqual(2)
    expect(count(mcp, OLD), 'остался старый список').toBe(0)
  })
})

describe('интерфейс', () => {
  it('у статуса есть значок, цвет, тег и точка', () => {
    // Пропущенная карта — падение на рендере: Record<Status, ...> требует все
    // ключи, но забытый цвет заметят только глазами.
    const types = app('components/tabs/tasks/types.ts')
    expect((types.match(/^\s+verified:/gm) ?? []).length, 'не все карты заполнены').toBeGreaterThanOrEqual(4)
  })

  it('сортировка ставит verified между review и done', () => {
    expect(app('components/tabs/tasks/TasksTable.tsx')).toMatch(
      /review: 2, verified: 3, done: 4/,
    )
  })

  it('переведён на три языка', () => {
    for (const lang of ['ru', 'en', 'he']) {
      const json = JSON.parse(app(`i18n/locales/${lang}.json`))
      expect(json.tasks.status.verified, `${lang}: нет перевода`).toBeTruthy()
    }
  })

  it('review переименован: «проверяется» → «ждёт проверки»', () => {
    /**
     * Название врало: «בבדיקה» значит «проверяется», то есть процесс идёт. А
     * задача могла лежать нетронутой неделю. Клиент просил именно это.
     */
    const he = JSON.parse(app('i18n/locales/he.json'))
    expect(he.tasks.status.review).toBe('ממתין לבדיקה')
    expect(he.tasks.status.verified).toBe('עבר בדיקות')
  })
})
