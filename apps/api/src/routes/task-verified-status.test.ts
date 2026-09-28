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
 * Когда статус появился, он жил в 13 файлах, и в трёх местах пропуск не был
 * виден сразу: молча пропадали напоминания, молча ломался ассистент, молча
 * расходились счётчики. С появлением «отменено» список переехал в ОДНО место
 * — lib/task-status.ts, — и остальные на него ссылаются. Здесь заперто и то,
 * и другое: список полный и в правильном порядке, а ссылки стоят там, где
 * раньше были копии.
 */

const api = (f: string) => readFileSync(join(import.meta.dirname, '..', f), 'utf8')
const app = (f: string) => readFileSync(join(import.meta.dirname, '../../../app/src', f), 'utf8')
const mcp = readFileSync(join(import.meta.dirname, '../../../mcp/src/index.ts'), 'utf8')

/** Полный список статусов в том порядке, в каком идёт работа; cancelled — выход. */
const FULL = "'todo', 'in_progress', 'review', 'verified', 'done', 'cancelled'"
/** Список до появления verified — его не должно остаться нигде. */
const OLD = "'todo', 'in_progress', 'review', 'done'"

/** Сколько раз строка встречается в файле. Подстрокой, без regex: списки
 *  статусов содержат кавычки и скобки, и экранировать их каждый раз — лишний
 *  повод ошибиться в самом тесте. */
const count = (hay: string, needle: string) => hay.split(needle).length - 1

describe('статус объявлен везде', () => {
  it('в едином списке — между review и done', () => {
    // Порядок в списке — порядок колонок на доске. В хвосте verified оказался
    // бы правее «Готово». cancelled — последним: это не ступень, а выход.
    const status = api('lib/task-status.ts')
    expect(status).toContain(`TASK_STATUSES = [${FULL}] as const`)
    // Порядок смотрим в самой строке списка: докблок выше упоминает 'done'
    // словами, и indexOf по всему файлу находил его раньше списка.
    const line = status.split(/\r?\n/).find((l) => l.includes('TASK_STATUSES = [')) ?? ''
    expect(line.indexOf("'verified'")).toBeGreaterThan(line.indexOf("'review'"))
    expect(line.indexOf("'verified'")).toBeLessThan(line.indexOf("'done'"))
  })

  it('перечисление базы берёт этот список, а не свою копию', () => {
    expect(api('db/schema.ts')).toMatch(/taskStatus = pgEnum\('task_status', TASK_STATUSES\)/)
  })

  it('миграция добавляет значение перед done', () => {
    const sql = readFileSync(join(import.meta.dirname, '../../drizzle/0086_task_verified.sql'), 'utf8')
    expect(sql).toMatch(/ADD VALUE IF NOT EXISTS 'verified' BEFORE 'done'/)
  })

  it('серверный список — ссылка, клиентский — тот же полный список', () => {
    expect(api('routes/tasks.ts'), 'серверный STATUSES').toContain('const STATUSES = TASK_STATUSES')
    expect(app('components/tabs/tasks/types.ts'), 'клиентский STATUSES').toContain(FULL)
  })

  it('список подписок на напоминания совпадает с серверным', () => {
    // Напоминания — единственный список без cancelled, и он намеренно свой:
    // «напомнить об отменённой» смысла не имеет. Но клиент и сервер обязаны
    // держать один и тот же набор.
    const reminder = "'todo', 'in_progress', 'review', 'verified', 'done'"
    expect(api('lib/task-status.ts'), 'REMINDER_STATUSES').toContain(`REMINDER_STATUSES = [${reminder}] as const`)
    expect(app('components/tabs/NotificationsTab.tsx'), 'список подписок').toContain(reminder)
    expect(api('routes/notifications.ts'), 'сервер напоминаний').toContain('z.enum(REMINDER_STATUSES)')
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

  it('ассистент знает про статусы во ВСЕХ схемах — ссылкой', () => {
    // Схем восемь. Раньше пропуск одной означал, что ассистент не сможет
    // поставить статус именно этим инструментом и не скажет почему. Теперь
    // пропустить нельзя — но копию завести можно, и это тоже пропуск.
    const memory = api('lib/memory.ts')
    expect(count(memory, OLD), 'осталась схема со старым списком').toBe(0)
    expect(count(memory, 'enum: [...TASK_STATUSES]'), 'схемы статусов не через общий список').toBeGreaterThanOrEqual(8)
  })

  it('счётчики считают verified отдельно', () => {
    // Иначе цифры на доске разойдутся с реальностью: задачи есть, а в
    // статистике их нет.
    expect(api('routes/bridge.ts'), 'счётчик моста').toMatch(/verified: sql<number>`count\(\*\) filter/)
    expect(api('routes/projects.ts'), 'счётчик обзора').toMatch(/verified: sql<number>`count\(\*\) filter/)
  })
})

describe('внешние контракты', () => {
  it('мост принимает статусы по общему списку', () => {
    const bridge = api('routes/bridge.ts')
    expect(count(bridge, '(TASK_STATUSES as readonly string[]).includes('), 'мост валидирует не по общему списку').toBeGreaterThanOrEqual(3)
    expect(count(bridge, OLD), 'остался старый список').toBe(0)
  })

  it('MCP тоже', () => {
    // MCP — отдельный пакет и в API не смотрит: у него своя копия, и за её
    // полноту отвечает этот тест.
    expect(count(mcp, FULL), 'MCP не знает полный список').toBeGreaterThanOrEqual(2)
    expect(count(mcp, OLD), 'остался старый список').toBe(0)
  })
})

describe('интерфейс', () => {
  it('у статуса есть значок, цвет, тег и точка', () => {
    // Пропущенная карта — падение на рендере: Record<Status, ...> требует все
    // ключи, но забытый цвет заметят только глазами.
    const types = app('components/tabs/tasks/types.ts')
    expect((types.match(/^\s+verified:/gm) ?? []).length, 'не все карты заполнены').toBeGreaterThanOrEqual(4)
    expect((types.match(/^\s+cancelled:/gm) ?? []).length, 'у cancelled не все карты').toBeGreaterThanOrEqual(4)
  })

  it('сортировка ставит verified между review и done, cancelled — после', () => {
    expect(app('components/tabs/tasks/TasksTable.tsx')).toMatch(/review: 2, verified: 3, done: 4, cancelled: 5/)
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
