import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Внешний состав не отнимает право менять роли.
 *
 * Когда людей ведёт Atlas, добавлять и убирать их у нас нельзя — это правда.
 * Но роли, права и должность остаются нашими, и сервер их не запирает: за
 * этим следит members-locked.test с формулировкой «иначе некому назначить
 * админа».
 *
 * Обёртка в main.tsx гасила canEdit ЦЕЛИКОМ по membersViaApiOnly — и админ
 * компании видел свою же команду под замком, с текстом «Роли и права
 * по-прежнему меняются здесь» прямо над списком. Интерфейс запрещал больше,
 * чем сервер, и противоречил собственной подписи.
 */

const main = readFileSync(join(import.meta.dirname, '../../../app/src/main.tsx'), 'utf8')
const tab = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/tabs/ProjectTeamTab.tsx'),
  'utf8',
)

/** Значение пропса canEdit в разметке TeamPage. */
const canEditProp = (() => {
  const at = main.indexOf('<ProjectTeamTab')
  const block = main.slice(at, main.indexOf('/>', at))
  const m = block.match(/canEdit=\{([\s\S]*?)\}\s*\n/)
  return m ? m[1] : ''
})()

describe('роли правятся и при внешнем составе', () => {
  it('canEdit НЕ зависит от membersViaApiOnly', () => {
    // Саботаж: вернуть `&& !project?.membersViaApiOnly` — админ снова
    // потеряет кнопки ролей на проектах Atlas.
    expect(canEditProp, 'canEdit не найден').toBeTruthy()
    expect(canEditProp).not.toMatch(/membersViaApiOnly/)
  })

  it('canEdit по-прежнему требует прав', () => {
    // Убрав зависимость от внешнего состава, нельзя случайно открыть всем.
    expect(canEditProp).toMatch(/myRole === 'owner'/)
    expect(canEditProp).toMatch(/myRole === 'admin'/)
    expect(canEditProp).toMatch(/isCompanyAdmin/)
  })
})

describe('состав при этом остаётся закрытым', () => {
  it('добавление и удаление гасит canChangeMembers', () => {
    expect(tab).toMatch(/const canChangeMembers = canEdit && !managedExternally/)
    // Кнопка «Добавить» в шапке и «Убрать» в строке — обе за этим флагом.
    expect(tab).toMatch(/canChangeMembers && \(/)
    expect(tab).toMatch(/canChangeMembers && !isOwner && \(/)
  })

  it('уровни прав закрыты обычным canEdit, а не составом', () => {
    // Именно они и пропали: переключатели уровней в развёрнутой карточке.
    expect(tab).toMatch(/disabled=\{!canEdit \|\| isOwner\}/)
  })
})
