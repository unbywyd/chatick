import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Меню профиля: три группы — компания, проект, личное.
 *
 * Пункты шли вперемешку: «показать тур» стоял между двумя проектными, два
 * разных входа в компанию оказались по разным концам списка и назывались
 * почти одинаково, личные пункты разрывались проектными. К чему относится
 * пункт, можно было понять, только открыв его.
 *
 * Здесь заперто не оформление, а два свойства, которые ломаются молча:
 * ни один пункт не потерялся при перестановке, и группы не перепутаны.
 */

const menu = readFileSync(join(import.meta.dirname, '../../../app/src/components/ProfileMenu.tsx'), 'utf8')

/** Ключи подписей в порядке появления — это и есть порядок пунктов на экране. */
const keys = [...menu.matchAll(/\{t\('([a-zA-Z.]+)'\)\}/g)].map((m) => m[1])

describe('меню профиля: группы', () => {
  it('ни один пункт не потерялся', () => {
    // Список снят с меню ДО перестановки. Пропажа пункта — самая незаметная
    // цена такой правки: экран выглядит целым, а входа куда-то больше нет.
    const before = [
      'about.title', 'bug.title', 'connect.menuItem', 'notif.system',
      'profile.changePhoto', 'profile.logout',
      'profile.projectSettings', 'profile.projectTeam', 'profile.title',
      'project.language', 'project.theme', 'shortcuts.title',
      'sidebar.companySettings', 'tabs.ai', 'tabs.notifications', 'tour.replay',
    ]
    for (const k of before) expect(keys, `пропал пункт ${k}`).toContain(k)
  })

  it('пункт не задвоился', () => {
    // Перестановка копипастой легко оставляет пункт и на старом месте.
    const seen = new Set<string>()
    for (const k of keys) {
      if (k.startsWith('profile.group')) continue // заголовки групп — не пункты
      expect(seen.has(k), `пункт ${k} встречается дважды`).toBe(false)
      seen.add(k)
    }
  })

  it('в компанию ведёт один пункт, а не два', () => {
    /**
     * Было «Настройки компании» и «Компания»: разные места — настройки против
     * обзора, — но по названиям неотличимые. Разницу можно было выяснить,
     * только сходив в оба.
     *
     * Настройки остались табом на экране компании, так что путь никуда не
     * делся; из меню он теперь один.
     */
    expect(keys.filter((k) => k.toLowerCase().includes('companysettings'))).toEqual(['sidebar.companySettings'])
  })

  it('группы идут в порядке: компания, проект, личное', () => {
    const groups = keys.filter((k) => k.startsWith('profile.group'))
    expect(groups).toEqual(['profile.groupCompany', 'profile.groupProject', 'profile.groupPersonal'])
  })

  it('пункты стоят в своей группе', () => {
    const at = (k: string) => keys.indexOf(k)
    const company = at('profile.groupCompany')
    const project = at('profile.groupProject')
    const personal = at('profile.groupPersonal')

    // Вход в компанию — до заголовка проекта.
    for (const k of ['sidebar.companySettings'])
      expect(at(k) > company && at(k) < project, `${k} не в группе компании`).toBe(true)

    for (const k of ['profile.projectSettings', 'profile.projectTeam', 'tabs.notifications', 'tabs.ai'])
      expect(at(k) > project && at(k) < personal, `${k} не в группе проекта`).toBe(true)

    // Тур — личное: он показывается человеку, а не проекту. Раньше стоял
    // посреди проектных пунктов.
    for (const k of ['profile.title', 'notif.system', 'connect.menuItem', 'tour.replay'])
      expect(at(k) > personal, `${k} не в личной группе`).toBe(true)
  })

  it('заголовок группы — не пункт меню', () => {
    // Иначе стрелка вниз останавливается на подписи, которую нельзя выбрать.
    const ui = readFileSync(join(import.meta.dirname, '../../../app/src/components/ui/dropdown-menu.tsx'), 'utf8')
    expect(ui).toMatch(/DropdownMenuLabel[\s\S]{0,400}?DropdownMenuPrimitive\.Label/)
  })
})
