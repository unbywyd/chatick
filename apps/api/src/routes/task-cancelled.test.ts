import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Статус «отменено».
 *
 * Не «добавили значение в enum», а пересмотр каждого места, где статус что-то
 * решает: в API 86 мест считали 'done' синонимом «закрыто», и без единого
 * правила отменённая задача осталась бы открытой в одной статистике, держала
 * бы блокеров в другой и висела просроченной в третьей.
 *
 * Семантика (см. документ проекта «Статус «Отменён»: семантика и все места»):
 *   закрыта    — done, cancelled            (открытые, блокеры, срок, доска)
 *   улажена    — done, verified, cancelled  (застрявшие, забытые, фильтры)
 *   достигнута — done                       (счётчики сделанного, прогресс)
 */

const api = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8').replace(/\r\n/g, '\n')
const app = (p: string) => readFileSync(join(import.meta.dirname, '../../../app/src', p), 'utf8').replace(/\r\n/g, '\n')
const loc = (l: string) => JSON.parse(readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${l}.json`), 'utf8'))

const status = api('lib/task-status.ts')
const schema = api('db/schema.ts')
const bridge = api('routes/bridge.ts')
const companies = api('routes/companies.ts')
const projects = api('routes/projects.ts')
const ext = api('routes/ext.ts')
const tasks = api('routes/tasks.ts')
const memory = api('lib/memory.ts')
const guide = api('lib/bridge-docs.ts')
const mcp = readFileSync(join(import.meta.dirname, '../../../mcp/src/index.ts'), 'utf8').replace(/\r\n/g, '\n')
const types = app('components/tabs/tasks/types.ts')
const tab = app('components/tabs/TasksTab.tsx')

/** Все .ts исходники API, кроме тестов, самого task-status.ts и сидов. */
function apiSources(dir = join(import.meta.dirname, '..')): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...apiSources(p))
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && e.name !== 'task-status.ts' && !e.name.startsWith('seed-')) out.push(p)
  }
  return out
}

describe('правило «закрыта» живёт в одном месте', () => {
  it('task-status.ts — единственный список статусов и оба набора «закрыто»', () => {
    expect(status).toContain("['todo', 'in_progress', 'review', 'verified', 'done', 'cancelled'] as const")
    expect(status).toContain("CLOSED_STATUSES: TaskStatus[] = ['done', 'cancelled']")
    expect(status).toContain("SETTLED_STATUSES: TaskStatus[] = ['done', 'verified', 'cancelled']")
    expect(status).toContain("closedSql = sql.raw(`('done','cancelled')`)")
    expect(status).toContain("settledSql = sql.raw(`('done','verified','cancelled')`)")
  })

  it('enum в схеме берётся из того же списка', () => {
    // Саботаж: вписать список в pgEnum руками — тест падает.
    expect(schema).toContain("pgEnum('task_status', TASK_STATUSES)")
  })

  it('в API не осталось ни одного сырого «<> done» / «not in (done, verified)»', () => {
    // Это и есть сторож всей затеи. Одно сырое сравнение — и отменённая
    // задача в этом месте снова «открыта».
    //
    // Саботаж: вернуть `status <> 'done'` куда угодно — тест называет файл и строку.
    const needles = ["<> 'done'", "not in ('done'", "'verified', 'done']"]
    const left: string[] = []
    for (const f of apiSources()) {
      readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (needles.some((n) => line.includes(n))) left.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(left, `сырые сравнения со статусом:\n${left.join('\n')}`).toEqual([])
  })
})

describe('отменённая — закрыта, но не достигнута', () => {
  it('блокер с любым закрытым статусом отпускает', () => {
    for (const [name, src] of [['tasks', tasks], ['bridge', bridge], ['companies', companies], ['memory', memory]] as const) {
      expect(src, `${name}: блокеры не через closedSql`).toContain('bt.status not in ${closedSql}')
    }
  })

  it('счётчики сделанного по-прежнему считают только done', () => {
    // Отмена — не достижение. Если это сломать, «сделано 12 из 20» станет
    // включать отменённые, и отчёт заказчику соврёт в его пользу.
    expect(companies).toContain("done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`")
    expect(projects).toContain("filter (where ${tasks.status} = 'done'), 0)::int`")
    expect(companies, 'метрика «закрыл за период» перестала быть достижением').toContain("t.status in ('done','verified')")
    expect(tasks, 'автосообщение «сделал» уходит не только на done').toContain("if (body.status === 'done' && task.status !== 'done') void postTaskDone(")
  })

  it('отменённая выходит из знаменателя', () => {
    // Иначе отмена роняла бы процент готовности, и команда избегала бы отменять.
    for (const [name, src] of [['companies', companies], ['projects', projects], ['ext', ext]] as const) {
      expect(src, `${name}: total считает отменённые`).toContain("count(*) filter (where ${tasks.status} <> 'cancelled')::int")
    }
    expect(projects, 'плановые часы считают отменённые').toContain("filter (where ${tasks.status} <> 'cancelled'), 0)::int")
    expect(tab, 'прогресс на доске считает отменённые').toContain("base = base.filter((task) => task.status !== 'cancelled')")
    expect(tab, 'числитель прогресса перестал быть done').toContain("const done = base.filter((task) => task.status === 'done').length")
  })

  it('доска: закрытые скрыты вместе, прогресс — отдельно', () => {
    expect(types).toContain("CLOSED_STATUSES: readonly Status[] = ['done', 'cancelled']")
    expect(types).toContain('cancelled: CircleOff,')
    expect(tab, 'по умолчанию скрыты только done').toContain('STATUSES.filter((s) => !isClosed(s))')
    expect(app('components/tabs/tasks/TaskContextMenu.tsx')).toContain("onPatch({ status: 'cancelled' })")
    expect(app('components/tabs/tasks/taskExcel.ts'), 'импорт не понимает «отменено»').toContain("отменено: 'cancelled'")
  })

  it('напоминаниям отменённые не предлагаются', () => {
    // Список статусов для напоминаний — свой: «напомнить об отменённых» не
    // имеет смысла, и в него cancelled не попадает.
    expect(app('components/tabs/NotificationsTab.tsx')).toContain("const STATUSES = ['todo', 'in_progress', 'review', 'verified', 'done'] as const")
  })

  it('переведено на три языка', () => {
    for (const l of ['en', 'ru', 'he']) {
      expect(loc(l).tasks.status.cancelled, `${l}: нет метки статуса`).toBeTruthy()
      expect(loc(l).tasks.markCancelled, `${l}: нет пункта меню`).toBeTruthy()
      expect(loc(l).tasks.showDone, `${l}: переключатель всё ещё «выполненные»`).not.toMatch(/done|выполнен|בוצע/i)
    }
  })
})

describe('мост и ассистенты знают про cancelled', () => {
  it('гайд: не ступень, а выход — по слову человека', () => {
    expect(guide).toContain('status: todo | in_progress | review | verified | done | cancelled')
    expect(guide).toContain('cancelled is not a rung')
    expect(mcp).toContain("status=cancelled is the exit from any rung and it is the person\\'s call")
    expect(memory).toContain("status=cancelled is the exit from any rung and it is the person\\'s call")
  })

  it('enum\'ы моста, MCP и ассистента чата содержат cancelled', () => {
    expect(bridge).toContain('(TASK_STATUSES as readonly string[]).includes(')
    expect((mcp.match(/z\.enum\(\['todo', 'in_progress', 'review', 'verified', 'done', 'cancelled'\]\)/g) ?? []).length).toBe(2)
    expect((memory.match(/enum: \[\.\.\.TASK_STATUSES\]/g) ?? []).length).toBe(8)
  })

  it('контекст моста считает cancelled отдельно, а «мои» — без закрытых', () => {
    expect(bridge).toContain("cancelled: sql<number>`count(*) filter (where ${tasks.status} = 'cancelled')::int`")
    expect(bridge).toContain('${tasks.status} not in ${closedSql})::int`')
  })

  it('PATCH на cancelled напоминает, чьё это решение', () => {
    // Проверить намерение на сервере нельзя — напоминаем в ответе: своё же
    // действие модель перечитывает всегда, описание инструмента — нет.
    expect(bridge).toContain("patch.status === 'cancelled' ? CANCEL_NOTICE : null")
    expect(bridge).toContain("...(patchNotices.length ? { warning: patchNotices.join('\\n') } : {})")
  })
})

describe('задачи от ассистента — коротко', () => {
  it('правило стоит везде, где ассистент читает, как писать задачи', () => {
    expect(guide).toContain('- KEEP TASKS SHORT.')
    expect(guide).toContain('- READ "warning" WHEN A WRITE RETURNS ONE.')
    expect(mcp, 'MCP task_create без правила').toContain("'KEEP IT SHORT: a task is what to do and how to check it")
    expect(memory, 'ассистент чата без правила').toContain("'KEEP IT SHORT: a task is what to do and how to check it")
  })

  it('длинное описание возвращает warning, а не отказ', () => {
    // Вход не ограничиваем: длинный текст бывает нужен, и решать это человеку.
    //
    // Саботаж: превратить lengthNotice в return c.json(..., 400) — тест падает.
    expect(bridge).toContain('function lengthNotice(description: string): string | null')
    expect(bridge).toContain('if (len <= 1500) return null')
    const at = bridge.indexOf('function lengthNotice(')
    expect(bridge.slice(at, bridge.indexOf('const taskView', at))).not.toContain('c.json(')
    expect(bridge, 'POST не сводит замечания в одно поле').toContain("const langNotice = notices.length ? notices.join('\\n') : null")
  })
})

describe('миграция', () => {
  it('файл есть, значение добавляется вне транзакции', () => {
    const p = join(import.meta.dirname, '../../drizzle/0097_task_cancelled.sql')
    expect(existsSync(p)).toBe(true)
    const sql = readFileSync(p, 'utf8')
    expect(sql).toContain(`ALTER TYPE "public"."task_status" ADD VALUE 'cancelled';`)
    expect(sql.toUpperCase(), 'ADD VALUE внутри транзакции').not.toContain('BEGIN')
  })
})
