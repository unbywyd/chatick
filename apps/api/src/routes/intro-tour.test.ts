import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Вводный тур: показать человеку, что здесь есть, один раз и без принуждения.

const app = (p: string) => readFileSync(join(import.meta.dirname, '../../../app/src', p), 'utf8')
const tour = app('components/Tour.tsx')
const hook = app('hooks/useProjectTour.ts')
const screen = app('screens/ProjectScreen.tsx')
const auth = readFileSync(join(import.meta.dirname, 'auth.ts'), 'utf8')
const schema = readFileSync(join(import.meta.dirname, '../db/schema.ts'), 'utf8')
const ru = JSON.parse(app('i18n/locales/ru.json'))
const en = JSON.parse(app('i18n/locales/en.json'))
const he = JSON.parse(app('i18n/locales/he.json'))

describe('промах мышью — не ответ', () => {
  // Человек кликнул мимо, чтобы сменить язык, — и потерял тур навсегда, даже
  // не поняв, что потерял. Щелчок мимо и Escape означают «уйди сейчас», а не
  // «больше никогда»: под затемнением почти всегда есть кнопка, в которую
  // целились.
  it('клик мимо только прячет', () => {
    expect(tour).toMatch(/absolute inset-0[^>]*onClick=\{onDismiss\}/)
  })

  it('Escape тоже только прячет', () => {
    expect(tour).toMatch(/e\.key === 'Escape'\) onDismiss\(\)/)
  })

  it('крестик — закрыть, а не отказаться', () => {
    // На карточке он означает «закрой это».
    const at = tour.indexOf("title={t('tour.close')}")
    expect(at, 'крестик не найден').toBeGreaterThan(-1)
    expect(tour.slice(at - 120, at)).toMatch(/onClick=\{onDismiss\}/)
  })

  it('в базу пишет только «Пропустить» и конец тура', () => {
    // Единственные два случая, когда человек ОТВЕТИЛ на вопрос.
    const calls = tour.match(/onClick=\{onDone\}/g) ?? []
    expect(calls.length, 'onDone повешен не только на «Пропустить»').toBe(1)
    expect(tour).toMatch(/last \? onDone\(\)/)
  })

  it('спрятанный тур вернётся при следующем заходе', () => {
    // Состояние в памяти, а не в базе.
    expect(screen).toMatch(/const \[tourHidden, setTourHidden\] = useState\(false\)/)
    expect(screen).toMatch(/onDismiss=\{\(\) => setTourHidden\(true\)\}/)
  })
})

describe('выйти можно всегда', () => {

  it('«Пропустить» словами, а не только значком', () => {
    // Крестик замечают не все, а он к тому же лишь прячет: отказаться можно
    // только этой кнопкой, и она должна быть подписана.
    expect(tour).toMatch(/tour\.skip/)
    expect(tour).toMatch(/tour\.close/)
  })
})

describe('показывается один раз', () => {
  it('отметка в базе, а не в браузере', () => {
    // Человек заходит с рабочего компьютера и с домашнего: отметка на
    // устройстве встретила бы его дважды.
    expect(schema).toMatch(/tourSeenAt: timestamp\('tour_seen_at'/)
    expect(hook).toMatch(/auth\/me\/tour-seen/)
  })

  it('закрытие и прохождение — одно и то же', () => {
    // Человек ответил на вопрос «нужно ли объяснять».
    expect(auth).toMatch(/tour-seen/)
    const at = auth.indexOf("auth.post('/me/tour-seen'")
    expect(auth.slice(at, at + 400)).toMatch(/tourSeenAt: new Date\(\)/)
  })

  it('гаснет сразу, не дожидаясь сервера', () => {
    // Нажал «закрыть» — окно исчезает в тот же миг.
    expect(hook).toMatch(/onMutate/)
  })

  it('не мигает тому, кто уже проходил', () => {
    // Пока ответ не пришёл, tourSeen неизвестен — показывать нельзя.
    expect(hook).toMatch(/tourSeen === false/)
  })

  it('можно запустить заново', () => {
    expect(auth).toMatch(/tour-reset/)
    expect(app('components/ProfileMenu.tsx')).toMatch(/tour\.replay/)
  })
})

describe('шаги ведут по продукту', () => {
  it('чат разворачивается перед рассказом о нём', () => {
    // Рассказывать про чат при свёрнутой панели — всё равно что показывать
    // на пустое место.
    expect(screen).toMatch(/if \(chatCollapsed\) toggleChatCollapsed\(\)/)
  })

  it('шаг без цели не срывает тур', () => {
    // Предыдущий шаг мог переключить вкладку, и элемента ещё нет в разметке.
    expect(tour).toMatch(/tries\+\+ < 10/)
  })

  it('покрыты все обещанные места', () => {
    for (const key of ['chat', 'tabs', 'projects', 'timer', 'company', 'assistant']) {
      expect(screen, key).toMatch(new RegExp(`key: '${key}'`))
    }
  })
})

describe('на языке человека', () => {
  it('все шаги переведены на три языка', () => {
    for (const key of ['chat', 'tabs', 'projects', 'timer', 'company', 'assistant']) {
      for (const [lang, dict] of [['ru', ru], ['en', en], ['he', he]] as const) {
        expect(dict.tour?.[key]?.title, `${lang}.${key}.title`).toBeTruthy()
        expect(dict.tour?.[key]?.text, `${lang}.${key}.text`).toBeTruthy()
      }
    }
  })

  it('кнопки тоже', () => {
    for (const [lang, dict] of [['ru', ru], ['en', en], ['he', he]] as const) {
      for (const k of ['next', 'back', 'finish', 'skip', 'replay']) {
        expect(dict.tour?.[k], `${lang}.${k}`).toBeTruthy()
      }
    }
  })
})

describe('приветствие перед туром', () => {
  const welcome = app('components/TourWelcome.tsx')
  const css = app('index.css')

  it('зовёт по имени', () => {
    expect(welcome).toMatch(/tour\.welcome\.hello/)
    expect(screen).toMatch(/name=\{me\.data\?\.name/)
  })

  it('переходит само через отсчёт', () => {
    // Человек, который просто смотрит, всё равно попадёт в тур.
    expect(welcome).toMatch(/const SECONDS = 10/)
    expect(welcome).toMatch(/tour\.welcome\.countdown/)
  })

  it('переход случается один раз', () => {
    // Строгий режим React монтирует эффект дважды: без защиты отсчёт шёл бы
    // вдвое быстрее, а onStart вызывался дважды.
    // Ищем САМУ защиту, а не слово в комментарии рядом: проверка на голое
    // «startedRef» проходила и с вырезанным кодом — рядом остаётся абзац,
    // объясняющий, зачем он нужен.
    expect(welcome).toMatch(/startedRef\.current = true/)
    // Ранний возврат: второй вызов ничего не делает. Форма может меняться,
    // важно, что защита стоит ДО установки флага.
    expect(welcome).toMatch(/if \(startedRef\.current\) return/)
  })

  it('своей отметки в базе нет', () => {
    // Иначе появилось бы состояние «поздоровались, но тур не показали», и
    // человек при следующем заходе попадал бы сразу в подсказки.
    expect(welcome).not.toMatch(/tour-seen|tourSeen/)
    expect(screen).toMatch(/const \[greeted, setGreeted\] = useState\(false\)/)
  })

  it('пройденный тур не здоровается', () => {
    expect(screen).toMatch(/tour\.show && !tourHidden && !greeted/)
  })

  it('движение отключается по просьбе системы', () => {
    // prefers-reduced-motion — не «поменьше анимации», а без неё.
    const at = css.indexOf('prefers-reduced-motion')
    expect(at, 'правило не найдено').toBeGreaterThan(-1)
    expect(css.slice(at, at + 700)).toMatch(/tour-welcome-title/)
  })

  it('фон непрозрачный', () => {
    // Полупрозрачный пробовали: сквозь него просвечивал интерфейс, и экран
    // выглядел грязно. Это отдельный момент, а не плёнка поверх работы.
    expect(welcome).toMatch(/bg-background/)
    expect(css).not.toMatch(/tour-welcome-backdrop/)
  })

  it('три пятна с разными периодами', () => {
    // Периоды взаимно простые (17, 23, 29): их сумма не повторяется почти
    // никогда, и движение не читается как зацикленная анимация.
    for (const n of ['a', 'b', 'c']) expect(css, n).toMatch(new RegExp(`\.tour-haze-${n} \{`))
    for (const sec of ['17s', '23s', '29s']) expect(css, sec).toContain(sec)
  })

  it('уход плавный и не обрывает появление', () => {
    // Резкое исчезновение после медленного прихода читается как сбой.
    expect(css).toMatch(/@keyframes tour-leave/)
    // Ожидание в коде совпадает с длительностью в CSS: иначе подсказка тура
    // вспыхнет поверх ещё видимого приветствия.
    const m = css.match(/animation: tour-leave (\d+)ms/)
    expect(m, 'длительность ухода не найдена').toBeTruthy()
    expect(welcome).toContain(`onStart, ${m![1]}`)
  })

  it('в светлой теме своя дымка', () => {
    // Тот же лайм на белом выцветает в бледно-жёлтый: светлота почти совпадает
    // с фоном, и остаётся только оттенок.
    expect(css).toMatch(/:root:not\(\.dark\) \.tour-haze-a/)
    expect(css).toMatch(/--brand-ink/)
  })

  it('полосы на размытии разбиты шумом', () => {
    // Браузер рисует сильный blur ступенями по 8 бит — на светлом фоне они
    // видны концентрическими кольцами.
    expect(css).toMatch(/\.tour-welcome-haze::after/)
    expect(css).toMatch(/feTurbulence/)
  })
})
