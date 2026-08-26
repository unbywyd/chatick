import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Наследование должности должно применяться ВЕЗДЕ, где её читают.
 *
 * mergeProfile был покрыт тестами и работал верно — а список команды проекта
 * его просто не звал: брал сырое projectMembers.jobTitle. Мост и контекст ИИ
 * звали. Одни и те же данные, разный ответ.
 *
 * Стоило это дороже, чем выглядит. Должность задана у компании: ассистент
 * знает её, а в команде проекта пусто. Читается как «не сохранилось», человек
 * вбивает заново — уже в проект. С этой секунды наследование для него мертво:
 * проектное значение сильнее, и смена в компании его больше не догонит.
 * Ни ошибки, ни следа.
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8')

/** Тело ручки: от её объявления до следующего объявления маршрута. */
function endpoint(src: string, head: string): string {
  const at = src.indexOf(head)
  if (at < 0) return ''
  const next = src.indexOf('Route.', at + head.length)
  return src.slice(at, next < 0 ? undefined : next)
}

describe('должность наследуется во всех читателях', () => {
  it('список команды проекта разрешает должность, а не отдаёт сырое поле', () => {
    const src = read('projects.ts')
    const list = endpoint(src, "projectsRoute.get('/:projectId/members'")
    expect(list, 'ручка списка команды не найдена').toBeTruthy()
    expect(list, 'список команды не зовёт profilesForProject — наследование потеряно').toContain(
      'profilesForProject',
    )
    // Ответ строится из разрешённого профиля, а не из строки таблицы.
    expect(list).toMatch(/jobTitle:\s*profile\?\.jobTitle/)
    expect(list).toMatch(/responsibility:\s*profile\?\.responsibility/)
  })

  it('список отдаёт и СОБСТВЕННОЕ значение проекта', () => {
    // Без него форма правки подставит унаследованное и запишет его как своё
    // при первом сохранении — оборвав наследование руками человека, который
    // ничего не менял.
    const src = read('projects.ts')
    const list = endpoint(src, "projectsRoute.get('/:projectId/members'")
    expect(list).toMatch(/ownJobTitle:\s*r\.jobTitle/)
    expect(list).toMatch(/ownResponsibility:\s*r\.responsibility/)
  })

  it('мост отдаёт ассистенту разрешённую должность', () => {
    const src = read('bridge.ts')
    const list = endpoint(src, "bridgeRoute.get('/members'")
    expect(list, 'ручка команды в мосту не найдена').toBeTruthy()
    expect(list).toContain('profilesForProject')
  })

  it('контекст ассистента тоже наследует', () => {
    expect(read('../lib/memory.ts')).toContain('profilesForProject')
  })
})

describe('форма правки трогает своё, а не унаследованное', () => {
  const form = readFileSync(
    join(import.meta.dirname, '../../../app/src/components/tabs/ProjectTeamTab.tsx'),
    'utf8',
  )

  it('поля начинаются с собственного значения проекта', () => {
    expect(form).toMatch(/const own = member\.ownJobTitle \?\? member\.jobTitle/)
    expect(form).toMatch(/useState\(own\)/)
    expect(form).toMatch(/useState\(ownResp\)/)
  })

  it('«изменено» считается от собственного значения', () => {
    // От разрешённого — и кнопка «Сохранить» появлялась бы сразу при открытии
    // формы у всех, кому должность досталась от компании.
    expect(form).toMatch(/dirty = jobTitle !== own \|\| responsibility !== ownResp/)
  })

  it('унаследованное показано подсказкой, а не подставлено в поле', () => {
    expect(form).toContain('projTeam.profileInherited')
    expect(form).toMatch(/placeholder=\{member\.jobTitle && !own \?/)
  })
})
