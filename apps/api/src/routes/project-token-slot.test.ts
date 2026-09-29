import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Слот проектного токена принадлежит проекту из адреса окна.
 *
 * Слот один (localStorage), а писателей было шесть. Один из них — десктопный
 * хук — ставил токен проекта, где идёт таймер, не меняя адреса. Окно на
 * Avents, токен от Just Us: заголовок (сессионный токен, по id) прав, а
 * таблица задач под ним — чужая. Человек пришёл по уведомлению из трея и
 * увидел ровно это.
 *
 * Правило: кто ставит токен в слот — тот и переходит в этот проект. Кому
 * нужен токен другого проекта, получает его явно и в слот не кладёт.
 */

const APP = join(import.meta.dirname, '../../../app/src')
const app = (p: string) => readFileSync(join(APP, p), 'utf8').replace(/\r\n/g, '\n')
const auth = readFileSync(join(import.meta.dirname, '../auth.ts'), 'utf8').replace(/\r\n/g, '\n')

/** Файлы клиента, где setProjectToken зовётся с настоящим токеном (не null). */
function writers(): string[] {
  const out = new Set<string>()
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) && e.name !== 'api.ts') {
        const src = readFileSync(p, 'utf8')
        // setProjectToken(null) — выход, это не «поставить токен»
        if (/setProjectToken\((?!null\))/.test(src)) out.add(p.slice(APP.length + 1).replace(/\\/g, '/'))
      }
    }
  }
  walk(APP)
  return [...out].sort()
}

describe('кто ставит токен, тот и переходит', () => {
  it('писатели слота — только те, кто уходит в этот проект', () => {
    // useProjectToken — по адресу; useOpenNotification, ProjectSwitcher и
    // StartScreen ставят токен и тут же переходят в тот же проект.
    // useDesktop в списке быть НЕ должно: он работает с проектом таймера,
    // а окно может смотреть другой.
    //
    // Саботаж: вернуть setProjectToken в useDesktop — тест называет файл.
    expect(writers()).toEqual([
      'components/chat/ProjectSwitcher.tsx',
      'hooks/useOpenNotification.ts',
      'hooks/useProjectToken.ts',
      'screens/StartScreen.tsx',
    ])
  })

  it('десктоп получает токен явно и передаёт его запросу', () => {
    const desktop = app('hooks/useDesktop.ts')
    // Вызов, а не слово: в комментарии оно есть намеренно — объясняет, что было.
    expect(desktop, 'enterProject всё ещё пишет в слот').not.toContain('setProjectToken(')
    expect(desktop, 'enterProject не возвращает токен').toContain('const enterProject = async (projectId: string): Promise<string>')
    expect((desktop.match(/\{ token: tok \}/g) ?? []).length, 'запросы таймера идут не с явным токеном').toBeGreaterThanOrEqual(3)
    expect(desktop, 'остался слотовый проектный запрос после входа в чужой проект').not.toMatch(/enterProject\([^)]*\)[\s\S]{0,400}, 'project'\)/)
  })

  it('api() умеет явный токен и не шлёт X-Project вместе с ним', () => {
    const api = app('lib/api.ts')
    expect(api).toContain("type Auth = Scope | { token: string }")
    expect(api).toContain("const claimed = !explicit && scope === 'project' ? projectIdFromLocation() : null")
    expect(api).toContain("...(claimed ? { 'X-Project': claimed } : {})")
  })
})

describe('подмену слота замечают', () => {
  it('setProjectToken объявляет об изменении, хук проекта слушает', () => {
    // Эффект хука зависит только от projectId: подмену слота без смены адреса
    // он иначе не увидит никогда.
    //
    // Саботаж: убрать dispatchEvent — тест падает.
    expect(app('lib/api.ts')).toContain('window.dispatchEvent(new Event(PROJECT_TOKEN_EVENT))')
    const hook = app('hooks/useProjectToken.ts')
    expect(hook).toContain('window.addEventListener(PROJECT_TOKEN_EVENT, onToken)')
    expect(hook, 'хук не возвращает токен адресу').toContain('void enter(projectId, false, true)')
    expect(hook, 'тихий вход сносит кэш вместо перезапроса').toContain('if (quiet) refetchProjectCache(qc)')
  })

  it('сервер не отдаёт данные проекта, который не совпадает с адресом', () => {
    // Последний рубеж: даже если все клиентские страховки промолчат, чужие
    // данные не отрисуются — придёт 409, и клиент обменяет токен.
    //
    // Саботаж: убрать проверку из requireProject — тест падает.
    expect(auth).toContain("const claimed = c.req.header('x-project')")
    expect(auth).toContain('if (claimed && claimed !== payload.projectId)')
    expect(auth).toMatch(/re-enter the project' \}, 409\)/)
    expect(app('lib/api.ts'), 'клиент по 409 не зовёт обмен токена').toContain('if (res.status === 409 && claimed) window.dispatchEvent(new Event(PROJECT_TOKEN_EVENT))')
  })
})
