import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Прочитанным уведомление делает только человек.
 *
 * Была автопометка: карточка гасла, продержавшись 2.5 секунды на экране.
 * Задумка «разглядел — значит прочитал» на деле работала иначе: лента
 * горизонтальная, на широком экране видно сразу несколько карточек, и они
 * гасли пачками просто оттого, что человек смотрит на страницу. На обзоре
 * компании, где лента собирает все проекты, за 13 секунд молча ушло два
 * десятка уведомлений — ни одного из них не открывали.
 *
 * Хуже всего, что потерю нельзя ни заметить, ни отменить: вернуть их удалось
 * только правкой в базе.
 */

const appDir = join(import.meta.dirname, '../../../app/src')
const inbox = readFileSync(join(appDir, 'components/ProjectInbox.tsx'), 'utf8')
const route = readFileSync(join(import.meta.dirname, 'inbox.ts'), 'utf8')

describe('уведомления не гаснут сами', () => {
  it('в ленте нет наблюдения за показом', () => {
    // Ни хука, ни таймеров, ни накопления id — гасить по факту показа нечем.
    expect(inbox, 'автопометка вернулась').not.toMatch(/useSeenLongEnough|onSeen|IntersectionObserver/)
  })

  it('механизм удалён, а не отключён флагом', () => {
    // Оставленный хук однажды подключат обратно «на минутку».
    expect(existsSync(join(appDir, 'hooks/useSeenLongEnough.ts')), 'хук вернулся в проект').toBe(false)
  })

  it('читать по-прежнему можно явными действиями', () => {
    /**
     * Три разных места, и каждое проверяется на своём якоре: вызовы
     * markRead.mutate({ ids: [n.id] }) в файле одинаковые, и проверка «есть
     * хоть один» проходила бы, даже если пометку при переходе удалить.
     */
    // Переход по ссылке — из окна деталей: клик по карточке теперь открывает
    // его, а не уводит сразу.
    expect(inbox, 'переход больше не гасит уведомление').toMatch(
      /const goTo = \(n: Notification\) => \{[\s\S]{0,300}?markRead\.mutate\(\{ ids: \[n\.id\] \}\)/,
    )
    expect(inbox, 'кнопка на карточке пропала').toMatch(/onClick=\{\(\) => markRead\.mutate\(\{ ids: \[n\.id\] \}\)\}/)
    expect(inbox, 'кнопка «прочитать все» пропала').toMatch(/onClick=\{\(\) => markRead\.mutate\(projectId \?/)
  })
})

describe('лента не заменяет собой экран уведомлений', () => {
  it('есть переход на все уведомления', () => {
    // При сотне карточек листать вбок бессмысленно: разбирать такую пачку
    // идут туда, где фильтры и вертикальный список.
    expect(inbox, 'из ленты некуда уйти').toMatch(/navigate\('\/inbox'\)/)
    expect(inbox).toMatch(/inbox\.seeAll/)
  })

  it('за полосу прокрутки можно ухватиться мышью', () => {
    // По умолчанию она волосяная, а именно мышью её и тянут, когда карточек
    // много.
    expect(inbox).toMatch(/scrollbar-thin/)
    const css = readFileSync(join(appDir, 'index.css'), 'utf8')
    expect(css, 'утилита scrollbar-thin не объявлена').toMatch(/\.scrollbar-thin/)
  })
})

describe('«прочитать все» знает границы компании', () => {
  it('кнопка под лентой компании шлёт companyId', () => {
    // Без него кнопка гасила уведомления ВСЕХ компаний: человек видел ленту
    // одной, а стирал и остальные.
    expect(inbox).toMatch(/\{ all: true, companyId \}/)
  })

  it('сервер ограничивает пометку проектами компании', () => {
    const handler = route.slice(route.indexOf('const now = new Date()'))
    expect(handler, 'ветка компании пропала').toMatch(/if \(all && companyId\)/)
    expect(handler).toMatch(/eq\(projects\.companyId, companyId\)/)
  })

  it('без companyId прежнее поведение сохранено', () => {
    // На экране выбора компании и в трее компании нет — там гасим всё.
    expect(route).toMatch(/\} else if \(all\) \{/)
  })

  it('колокольчик внутри компании не выходит за её пределы', () => {
    /**
     * Колокольчик виден и на /start (компании нет — список правда общий, и
     * кнопка честно относится ко всему), и внутри компании, где человек
     * видит одну, а гасил бы все свои разом.
     *
     * Компанию берём из адреса: она есть и в /start/:companyId, и в
     * /c/:companyId/p/:id.
     */
    const bell = readFileSync(join(appDir, 'components/NotificationBell.tsx'), 'utf8')
    expect(bell, 'колокольчик не знает компанию').toMatch(/const \{ companyId \} = useParams\(\)/)
    expect(bell, 'кнопка снова гасит все компании').toMatch(
      /markRead\.mutate\(companyId \? \{ all: true, companyId \} : \{ all: true \}\)/,
    )
  })

  it('экран «Мне» гасит всё — там компании нет по устройству', () => {
    // Маршрут /inbox без компании, и список показывает все проекты: кнопка
    // совпадает с тем, что под ней.
    const screen = readFileSync(join(appDir, 'screens/InboxScreen.tsx'), 'utf8')
    expect(screen).toMatch(/markRead\.mutate\(\{ all: true \}\)/)
  })
})
