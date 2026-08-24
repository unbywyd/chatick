import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Архив проектов: убрать с глаз, ничего не удаляя.
 *
 * У StartPlan 22 проекта, часть закончена, и они висят наравне с живыми.
 * Архив — две операции, положить и достать; данные не трогаются вовсе.
 *
 * Здесь заперты границы: где архивный проект пропадает, где остаётся, и кто
 * вправе его туда отправить.
 */

const api = (f: string) => readFileSync(join(import.meta.dirname, '..', f), 'utf8')
const app = (f: string) => readFileSync(join(import.meta.dirname, '../../../app/src', f), 'utf8')

describe('колонка и миграция', () => {
  it('archivedAt — отдельная колонка, не deletedAt', () => {
    /**
     * Смысл разный и цена ошибки разная: архив обратим и ничего не трогает,
     * удаление необратимо. Свести их в одну колонку значит однажды стереть
     * то, что просили просто убрать из списка.
     */
    const schema = api('db/schema.ts')
    expect(schema).toMatch(/archivedAt: timestamp\('archived_at'/)
  })

  it('миграция не трогает существующие проекты', () => {
    // Nullable без умолчания: NULL читается как «живой», и 22 проекта
    // StartPlan остаются там же, где были.
    const sql = readFileSync(join(import.meta.dirname, '../../drizzle/0087_project_archive.sql'), 'utf8')
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "archived_at" timestamptz;/)
    expect(sql, 'умолчание сделало бы архивными всех').not.toMatch(/archived_at" timestamptz DEFAULT/)
  })
})

describe('где архивный проект пропадает', () => {
  it('из списка проектов компании', () => {
    // Один список кормит сайдбар, дашборд и переключатель — фильтр здесь
    // закрывает сразу все три.
    expect(api('routes/projects.ts')).toMatch(
      /archived === '1' \? isNotNull\(projects\.archivedAt\) : isNull\(projects\.archivedAt\)/,
    )
  })

  it('из панели «Мои задачи»', () => {
    // Панель собирает задачи всех проектов компании: без фильтра законченный
    // проект продолжал бы подсовывать свои задачи.
    expect(api('routes/tasks.ts')).toMatch(
      /eq\(projectMembers\.userId, sub\), isNull\(projects\.archivedAt\)/,
    )
  })

  it('из списков моста — ассистент не предлагает законченное', () => {
    const bridge = api('routes/bridge.ts')
    expect(bridge).toMatch(/eq\(projectMembers\.userId, id\.userId\), isNull\(projects\.archivedAt\)/)
    expect(bridge).toMatch(/eq\(projects\.companyId, id\.companyId\), isNull\(projects\.archivedAt\)/)
  })
})

describe('где остаётся доступен', () => {
  it('по прямой ссылке через мост', () => {
    /**
     * Адресный запрос по projectId фильтровать нельзя: «убрали с глаз» не
     * должно превращаться в «отобрали доступ».
     */
    const bridge = api('routes/bridge.ts')
    expect(bridge).toMatch(/id\.projectId\s*\?\s*await db\.query\.projects\.findMany\(\{ where: eq\(projects\.id, id\.projectId\) \}\)/)
  })

  it('во внешнем API — с признаком архива', () => {
    // Внешняя система ведёт свой учёт и должна видеть всё; решает сама.
    const ext = api('routes/ext.ts')
    expect(ext).toMatch(/archived: Boolean\(p\.archivedAt\)/)
  })
})

describe('права', () => {
  it('архивирует начальство проекта или компании', () => {
    /**
     * Внутри самой mayArchive, а не где-то в файле: canCreateProjects
     * встречается и в других местах, и проверка «есть в файле» проходила бы
     * с наглухо закрытой архивацией.
     */
    const routes = api('routes/projects.ts')
    const fn = routes.match(/async function mayArchive[\s\S]*?\n\}/)?.[0] ?? ''
    expect(fn, 'функция прав не найдена').not.toBe('')
    expect(fn, 'админ компании больше не может архивировать').toMatch(/canCreateProjects\(companyRole\)/)
    expect(fn, 'начальство проекта больше не может').toMatch(/membership\?\.role === 'owner'/)
  })

  it('обе ручки закрыты одной проверкой', () => {
    const routes = api('routes/projects.ts')
    const post = routes.slice(routes.indexOf("projectsRoute.post('/:projectId/archive'"))
    const del = routes.slice(routes.indexOf("projectsRoute.delete('/:projectId/archive'"))
    expect(post.slice(0, 500)).toMatch(/mayArchive\(projectId, sub\)/)
    expect(del.slice(0, 500)).toMatch(/mayArchive\(projectId, sub\)/)
  })

  it('внешние ручки требуют права на проекты', () => {
    const ext = api('routes/ext.ts')
    expect(ext).toMatch(/'\/projects\/:externalId\/archive', guard\('projects:write'\)/)
  })
})

describe('поведение', () => {
  it('повторная архивация не сдвигает дату', () => {
    // «Когда убрали» — это факт, и переписывать его вторым нажатием незачем.
    expect(api('routes/projects.ts')).toMatch(/if \(!check\.project\.archivedAt\) \{/)
    expect(api('routes/ext.ts')).toMatch(/if \(!project\.archivedAt\) \{/)
  })

  it('возврат обнуляет отметку', () => {
    expect(api('routes/projects.ts')).toMatch(/set\(\{ archivedAt: null \}\)/)
  })

  it('архив не удаляет — каскадов нет', () => {
    /**
     * Ручки архива трогают ровно одну колонку. Появись здесь delete по
     * задачам или сообщениям — это уже не архив.
     */
    const routes = api('routes/projects.ts')
    const post = routes.slice(
      routes.indexOf("projectsRoute.post('/:projectId/archive'"),
      routes.indexOf("projectsRoute.delete('/:projectId/archive'"),
    )
    expect(post, 'архив что-то удаляет').not.toMatch(/db\.delete\(/)
  })
})

describe('интерфейс', () => {
  it('переключатель запрашивает архивный список', () => {
    expect(app('screens/StartScreen.tsx')).toMatch(/showArchived \? '&archived=1' : ''/)
  })

  it('переключение сбрасывает и сайдбар, и трей', () => {
    // Проект переезжает из одного списка в другой — если обновить только
    // текущий, в сайдбаре он останется висеть до перезагрузки.
    const start = app('screens/StartScreen.tsx')
    const mut = start.slice(start.indexOf('const archive = useMutation'))
    expect(mut.slice(0, 800)).toMatch(/queryKey: \['sidebar-projects'\]/)
    expect(mut.slice(0, 800)).toMatch(/queryKey: \['tray-projects'\]/)
  })
})
