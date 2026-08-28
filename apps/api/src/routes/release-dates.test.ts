import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Даты в таблице версий.
 *
 * Пришло репортом: человек искал, когда собрали сборку, и не нашёл. В таблице
 * стояла одна колонка — «Выкачено», и она пуста у всего, что не дошло до
 * магазина. На живых данных пуста была у ВСЕХ четырёх версий: одна собрана,
 * три в тестировании.
 *
 * «Заведена» и «Выкачено» — разные даты и расходятся на недели: собрали
 * 12 августа, выкатили 20-го. Одна вместо двух отвечает не на тот вопрос.
 */

const tab = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/tabs/ReleasesTab.tsx'),
  'utf8',
)

describe('в таблице обе даты', () => {
  it('колонка «Заведена» есть', () => {
    expect(tab).toMatch(/\{ key: 'created', label: t\('releases\.createdAt'\)/)
  })

  it('и по ней сортируют', () => {
    // Колонка без сортировки бесполезна там, где ищут «последнюю сборку».
    expect(tab).toMatch(/case 'created':/)
    expect(tab).toMatch(/new Date\(a\.createdAt\)\.getTime\(\) - new Date\(b\.createdAt\)\.getTime\(\)/)
  })

  it('даты не перепутаны местами', () => {
    // Саботаж: подставить releasedAt в ячейку «Заведена» — колонка снова
    // станет прочерками, но теперь под другим заголовком.
    const at = tab.indexOf("label: t('releases.createdAt')")
    const cells = tab.slice(tab.indexOf('<tbody'))
    expect(at, 'колонки createdAt нет').toBeGreaterThan(-1)
    expect(cells).toMatch(/new Date\(r\.createdAt\)\.toLocaleDateString/)
    expect(cells).toMatch(/r\.releasedAt \? new Date\(r\.releasedAt\)/)
  })

  it('со временем, а не только датой', () => {
    // В один день собирают по нескольку раз: две сборки 27-го числа без
    // времени неотличимы.
    expect(tab).toMatch(/toLocaleTimeString\(locale, \{ hour: '2-digit', minute: '2-digit' \}\)/)
  })
})

describe('автора в таблице нет', () => {
  it('колонка убрана', () => {
    // Здесь смотрят, ЧТО за версия и где она, а не кто её завёл. Автор
    // остался на странице версии.
    expect(tab).not.toMatch(/\{ key: 'owner', label:/)
    expect(tab).not.toMatch(/case 'owner':/)
  })

  it('и аватар не рисуется', () => {
    expect(tab).not.toMatch(/<Avatar name=\{r\.owner/)
  })

  it('на СТРАНИЦЕ версии он остался', () => {
    // Убрать его отовсюду значило бы потерять сведения, а не разгрузить
    // таблицу.
    const page = readFileSync(
      join(import.meta.dirname, '../../../app/src/components/tabs/ReleasePage.tsx'),
      'utf8',
    )
    expect(page).toMatch(/releases\.owner/)
  })
})

describe('«Выкачено» заполняется только в проде', () => {
  it('дата ставится на живой стадии, а не на любой', () => {
    // Иначе «выкачено» означало бы «собрано», и колонка врала бы вместо того,
    // чтобы пустовать.
    const bridge = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')
    expect(bridge).toMatch(/releasedAt: isLiveStage\(type, status\) \? new Date\(\) : null/)
  })
})

describe('плейсхолдер не залипает между табами чата', () => {
  const panel = readFileSync(
    join(import.meta.dirname, '../../../app/src/components/chat/ChatPanel.tsx'),
    'utf8',
  )

  it('композер перемонтируется при смене режима', () => {
    // Без ключа оставался один редактор на оба таба, и подсказка «залипала»
    // от того, где чат открыли первым: заходишь в группу — «Написать в
    // группу» держится и у ассистента.
    //
    // Правка настройки расширения на месте чинит смену ЯЗЫКА, но плагин
    // пересобирает декорации не на всякую транзакцию, и переключение таба
    // через неё не проходило.
    const at = panel.indexOf('<Composer')
    expect(at, 'композера нет').toBeGreaterThan(-1)
    expect(panel.slice(at, at + 1400)).toMatch(/key=\{mode\}/)
  })

  it('подсказки у режимов разные', () => {
    // Если строки совпадут, ключ ничего не спасёт — и заметить это можно
    // будет только глазами.
    const ru = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../app/src/i18n/locales/ru.json'), 'utf8'),
    ) as { chat: Record<string, string> }
    expect(ru.chat.placeholderGroup).not.toBe(ru.chat.placeholderAi)
  })
})
