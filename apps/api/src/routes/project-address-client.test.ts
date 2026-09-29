import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Клиент называет проект адресом окна, а не проектным токеном.
 *
 * Был слот проектного токена в localStorage — один на все окна и вкладки, и
 * шесть писателей. Десктоп ставил туда токен проекта с таймером, не меняя
 * адреса: окно Avents показывало задачи Just Us. Заплатки (событие о подмене,
 * 409 на расхождение) держали, но каждая новая фича, ходящая в другой проект,
 * снова упиралась в вопрос «чей токен сейчас в слоте».
 *
 * Теперь слота нет. Проектный запрос несёт сессию и X-Project; проект — из
 * адреса или назван явно ({ project }). Серверная сторона — в
 * project-from-address.test.ts.
 */

const APP = join(import.meta.dirname, '../../../app/src')
const app = (p: string) => readFileSync(join(APP, p), 'utf8').replace(/\r\n/g, '\n')

function sources(): { path: string; src: string }[] {
  const out: { path: string; src: string }[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) {
        out.push({ path: p.slice(APP.length + 1).replace(/\\/g, '/'), src: readFileSync(p, 'utf8') })
      }
    }
  }
  walk(APP)
  return out
}

describe('слота проектного токена больше нет', () => {
  it('никто не читает и не пишет проектный токен', () => {
    const all = sources()
    // Пустой обход дал бы ложный зелёный — так уже бывало со сторожем хуков.
    expect(all.length, 'файлы клиента не найдены').toBeGreaterThan(100)
    // Саботаж: вернуть getProjectToken в любой файл — тест называет его.
    const users = all.filter((f) => /getProjectToken|setProjectToken|PROJECT_TOKEN_EVENT|useProjectToken/.test(f.src)).map((f) => f.path)
    expect(users).toEqual([])
  })

  it('старый ключ только убирается при выходе', () => {
    const api = app('lib/api.ts')
    expect(api).toContain("const LEGACY_PROJECT_KEY = 'chatick_project_token'")
    expect(api.match(/LEGACY_PROJECT_KEY/g)?.length, 'старый ключ снова где-то читается').toBe(2)
    expect(api).toContain('localStorage.removeItem(LEGACY_PROJECT_KEY)')
  })
})

describe('проект — из адреса или назван явно', () => {
  it('api(): сессия + X-Project; проект из адреса или { project }', () => {
    const api = app('lib/api.ts')
    expect(api).toContain("type Auth = 'session' | 'project' | { project: string }")
    expect(api).toContain(
      "const project = typeof scope === 'object' ? scope.project : scope === 'project' ? projectIdFromLocation() : null",
    )
    // Токен — всегда сессия, другого нет.
    expect(api).toContain('const token = getSessionToken()')
    expect(api).toContain("...(project ? { 'X-Project': project } : {}),")
  })

  it('прямые загрузки файлов идут с теми же заголовками', () => {
    // FormData не пролезает через api() — у таких мест свой fetch. Раньше
    // каждый сам собирал Authorization с проектным токеном.
    const uploads = sources().filter((f) => /projectHeaders\(\)/.test(f.src))
    const count = uploads.reduce((n, f) => n + (f.src.match(/headers: projectHeaders\(\)/g)?.length ?? 0), 0)
    expect(count, 'загрузки снова собирают заголовки сами').toBeGreaterThanOrEqual(9)
  })

  it('десктоп называет проект таймера явно, а не берёт из адреса', () => {
    const desktop = app('hooks/useDesktop.ts')
    expect((desktop.match(/\{ project: (target|current\.projectId|task\.project\.id) \}/g) ?? []).length).toBeGreaterThanOrEqual(4)
    // Запрос в проект таймера «по адресу» ушёл бы в проект, открытый в окне.
    expect(desktop, "запрос таймера снова идёт по адресу окна").not.toMatch(/\/api\/v1\/time\/[^\n]*'project'\)/)
  })

  it('переход в другой проект — просто переход', () => {
    // Раньше: обменять токен, положить в слот, перезагрузить страницу.
    expect(app('components/chat/ProjectSwitcher.tsx')).toContain('const open = (pid: string) => navigate(`/c/${companyId}/p/${pid}`)')
    const notif = app('hooks/useOpenNotification.ts')
    expect(notif).not.toContain('window.location.reload()')
    expect(notif).not.toContain('/enter')
  })
})

describe('сокеты и картинки', () => {
  it('сокет проекта: сессия + ?project=', () => {
    const sock = app('hooks/useProjectSocket.ts')
    expect(sock).toContain('const token = getSessionToken()')
    expect(sock).toContain('&project=${encodeURIComponent(projectId)}')
  })

  it('совместное редактирование: сессия, проект сервер берёт у документа', () => {
    expect(app('lib/yjs-provider.ts')).toContain('const token = getSessionToken()')
  })

  it('картинки в адресе — медиа-токен, не сессия', () => {
    // Адрес картинки копируют и пересылают; сессия в нём открывала бы весь
    // аккаунт. Саботаж: подставить getSessionToken — тест падает.
    const api = app('lib/api.ts')
    for (const fn of ['withDocImageAuth', 'withInlineImageAuth']) {
      const body = api.slice(api.indexOf(`export function ${fn}`), api.indexOf('\n}\n', api.indexOf(`export function ${fn}`)))
      expect(body, `${fn} не найдена`).not.toBe('')
      expect(body).toContain('const token = getMediaToken()')
      expect(body).not.toContain('getSessionToken')
    }
    // Медиа-токен выписан на человека — при смене сессии он чужой.
    expect(api).toMatch(/export const setSessionToken[\s\S]{0,200}localStorage\.removeItem\(MEDIA_KEY\)/)
  })

  it('до первого показа проекта медиа-токен уже получен', () => {
    // Иначе картинки первого экрана битые, а перерисовать их потом некому.
    expect(app('hooks/useProjectAccess.ts')).toContain('await Promise.all([projectAccess(id), ensureMediaToken()])')
  })
})

describe('хук проекта', () => {
  const hook = app('hooks/useProjectAccess.ts')

  it('состояние помнит, к какому проекту относится', () => {
    // Без этого на первом кадре после смены адреса стоит 'ready' прошлого
    // проекта, и вкладки рисуют его кэш под новым заголовком.
    expect(hook).toContain("const current: State = state.for === projectId ? state : { status: 'loading' }")
  })

  it('правила чата — отдельной ручкой, вход без токена', () => {
    expect(hook).toContain('api(`/api/v1/projects/${id}/rules/accept`')
    expect(hook).not.toContain('/enter')
  })
})
