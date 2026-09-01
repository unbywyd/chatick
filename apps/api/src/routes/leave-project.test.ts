import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Из проекта можно выйти самому.
 *
 * Попасть в проект человек мог, а уйти — нет: удаление участника доступно
 * только начальству (owner, admin проекта, менеджер компании), и обычному
 * участнику оставалось просить, чтобы его убрали. Дыра тихая: ничего не
 * ломается, просто выхода нет, и найти его нельзя, потому что его не было.
 *
 * Отдельная ручка, а не «удали сам себя» через существующую: там проверка
 * прав, и ослаблять её ради этого случая значило бы открыть настоящую дыру.
 */

const projects = readFileSync(join(import.meta.dirname, 'projects.ts'), 'utf8')
const menu = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/ProfileMenu.tsx'),
  'utf8',
)

const leave = (() => {
  const at = projects.indexOf("projectsRoute.post('/:projectId/leave'")
  expect(at, 'ручка выхода из проекта не найдена').toBeGreaterThan(-1)
  return projects.slice(at, projects.indexOf("projectsRoute.delete('/:projectId/members/:userId'", at))
})()

describe('кто может выйти', () => {
  it('владелец — нет', () => {
    // Он в проекте один и часто единственное начальство: уйдя, оставит проект
    // без того, кто вернёт людей и раздаст права. Та же причина, по которой
    // его нельзя удалить — правило рядом, в соседней ручке.
    //
    // Саботаж: убрать проверку — проект можно осиротить одним нажатием.
    expect(leave, 'владелец может выйти и осиротить проект').toMatch(/if \(me\.role === 'owner'\)/)
    expect(leave, 'отказ не говорит, что делать вместо').toMatch(/hand the project over/)
  })

  it('не участник получает отказ, а не тихое «ок»', () => {
    // Иначе повторное нажатие выглядит успешным, хотя ничего не делает.
    expect(leave).toMatch(/if \(!me\) return c\.json\(\{ error: 'You are not a member of this project' \}, 400\)/)
  })

  it('внешний состав команды не трогаем', () => {
    // Там участников ведёт чужая система: она вернёт человека при следующей
    // синхронизации, и получится дёрганье — вышел, вернули, снова вышел.
    expect(leave).toMatch(/membersLockedForCompany\(project\.companyId\)/)
  })
})

describe('что происходит при выходе', () => {
  it('уходит только членство', () => {
    // Задачи, комментарии и часы остаются: они принадлежат проекту, а не
    // строке доступа. Удаляем ровно одну запись.
    expect(leave.replace(/\s+/g, ' ')).toContain(
      'db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, sub)))',
    )
    expect(leave, 'выход задевает что-то ещё, кроме членства').not.toMatch(/db\.delete\(tasks|db\.delete\(taskComments|db\.delete\(timeEntries/)
  })

  it('след остаётся в журнале проекта', () => {
    // Иначе команда видит, что человек пропал, и не знает, ушёл он сам или
    // его убрали.
    expect(leave).toMatch(/entityLabel: 'left the project'/)
  })
})

describe('интерфейс', () => {
  it('пункт есть и только внутри проекта', () => {
    expect(menu).toMatch(/\{projectId && !isOwner && \(/)
    expect(menu).toMatch(/t\('profile\.leaveProject'\)/)
  })

  it('владельцу пункт не показываем', () => {
    // Сервер откажет, но предлагать то, что не сработает, незачем.
    expect(menu).toMatch(/isOwner\?: boolean/)
  })

  it('спрашиваем подтверждение', () => {
    // Случайное нажатие в меню рядом с «выйти из аккаунта» стоило бы доступа.
    const at = menu.indexOf('const leaveProject')
    const fn = menu.slice(at, menu.indexOf('const logout', at))
    expect(fn, 'выход из проекта без подтверждения').toMatch(/await confirm\(\{/)
    expect(fn, 'не сказано, что будет с работой').toMatch(/profile\.leaveProjectNote/)
  })

  it('проектный токен сбрасывается', () => {
    // Иначе следующий запрос уходит со старым токеном и возвращает 403 на
    // пустом экране — выглядит как поломка, а не как результат.
    const at = menu.indexOf('const leaveProject')
    const fn = menu.slice(at, menu.indexOf('const logout', at))
    expect(fn).toMatch(/setProjectToken\(null\)/)
    expect(fn, 'человек остаётся на странице, куда уже нет доступа').toMatch(/navigate\('\/start'\)/)
  })
})

describe('перевод на три языка', () => {
  for (const lang of ['ru', 'en', 'he']) {
    it(`${lang}: строки выхода переведены`, () => {
      const json = JSON.parse(
        readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${lang}.json`), 'utf8'),
      ) as { profile: Record<string, string> }
      for (const key of ['leaveProject', 'leaveProjectConfirm', 'leaveProjectNote', 'leftProject']) {
        expect(json.profile?.[key], `${lang}.profile.${key} отсутствует`).toBeTruthy()
      }
    })
  }
})
