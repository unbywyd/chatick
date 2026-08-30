import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * «Expo подключён» значит «сборки доходят», а не «кнопку нажали».
 *
 * Признак connected говорит только о НАШЕЙ половине дела: секрет заведён.
 * Вторую половину делают руками в чужой системе — `eas webhook:create`, — и
 * знать о ней можно единственным способом: постучались к нам или нет.
 *
 * Пока кнопка смотрела на один connected, она загоралась в секунду нажатия и
 * не меняла показаний никогда. На живых данных из трёх проектов с интеграцией
 * сборки доходили от одного: WashMe семнадцать дней показывал «подключён», не
 * получив ни единого события.
 *
 * Врёт такой признак тихо — человек уверен, что настроил, и ждёт версий,
 * которые не придут.
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8')
const integrations = read('integrations.ts')
const ui = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/tabs/ExpoIntegration.tsx'),
  'utf8',
)

describe('сервер отвечает, работает ли связь на самом деле', () => {
  it('live выводится из lastEventAt, а не из наличия строки', () => {
    // Саботаж: live: true рядом с connected — и признак снова врёт.
    const at = integrations.indexOf("integrationsRoute.get('/expo'")
    const fn = integrations.slice(at, integrations.indexOf("integrationsRoute.post('/expo'"))
    expect(fn, 'live не считается по lastEventAt').toMatch(/live: Boolean\(row\.lastEventAt\)/)
    expect(fn, 'live захардкожен').not.toMatch(/live: true/)
  })

  it('только что созданная интеграция живой не считается', () => {
    // Событий по ней не было и быть не могло: секунду назад её не существовало.
    const at = integrations.indexOf("integrationsRoute.post('/expo'")
    const fn = integrations.slice(at, integrations.indexOf("integrationsRoute.delete('/expo'"))
    expect(fn).toMatch(/connected: true, live: false/)
    // А вот повторное подключение отдаёт настоящее состояние: интеграция уже
    // могла работать месяц.
    expect(fn).toMatch(/live: Boolean\(existing\.lastEventAt\)/)
  })

  it('вебхук отмечает приход события — иначе признаку неоткуда взяться', () => {
    // Саботаж: убрать обновление lastEventAt — live навсегда останется false,
    // и кнопка будет врать в другую сторону.
    const at = integrations.indexOf("expoHookRoute.post('/expo/:secret'")
    const fn = integrations.slice(at)
    expect(fn.replace(/\s+/g, ' ')).toContain('.set({ lastEventAt: new Date() })')
  })

  it('отметка ставится ДО разбора события', () => {
    // Сборку может не удаться сопоставить с версией — и тогда ручка отвечает
    // раньше. Отметь мы позже, живая интеграция считалась бы мёртвой.
    const at = integrations.indexOf("expoHookRoute.post('/expo/:secret'")
    const fn = integrations.slice(at)
    expect(fn.indexOf('lastEventAt: new Date()')).toBeLessThan(fn.indexOf('matchRelease('))
  })
})

describe('кнопка показывает три состояния', () => {
  it('ярко горит только по live, а не по connected', () => {
    // Саботаж: вернуть connected в проверку цвета.
    const at = ui.indexOf("'inline-flex shrink-0 items-center gap-1.5")
    const cls = ui.slice(at, at + 700)
    expect(cls.replace(/\s+/g, ' '), 'подсветка вернулась к connected').toMatch(
      /live \? 'border-brand\/40 bg-brand\/10 text-brand-ink'/,
    )
  })

  it('ожидание — отдельная надпись, а не «подключён»', () => {
    expect(ui).toMatch(/waiting \? t\('expo\.waiting'\) : connected \? t\('expo\.connected'\)/)
    expect(ui).toMatch(/const waiting = connected && !live/)
  })

  it('в модалке сказано, что делать', () => {
    // Одной надписи на кнопке мало: человек должен узнать, что команду,
    // возможно, не выполнили.
    expect(ui).toMatch(/waiting && \(/)
    expect(ui).toMatch(/expo\.waitingExplain/)
  })
})

describe('перевод на три языка', () => {
  for (const lang of ['ru', 'en', 'he']) {
    it(`${lang}: состояние ожидания переведено`, () => {
      const json = JSON.parse(
        readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${lang}.json`), 'utf8'),
      ) as { expo: Record<string, string> }
      for (const key of ['waiting', 'waitingHint', 'waitingExplain']) {
        expect(json.expo[key], `${lang}.expo.${key} отсутствует`).toBeTruthy()
      }
    })
  }
})
