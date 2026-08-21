import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Клик по уведомлению показывает детали, а не гасит его.
 *
 * Раньше клик сразу уводил по ссылке и помечал прочитанным. Ссылки часто нет
 * вовсе — тогда normalizeLink подставлял /tasks, и человек тыкал в
 * уведомление, оказывался неизвестно где, а само оно исчезало без следа.
 * Прочитать длинный текст было негде: в карточку он не влезает.
 *
 * Теперь клик открывает окно с полным текстом, автором и датой. Переход —
 * отдельной кнопкой, и только когда есть куда идти. Прочитанным уведомление
 * становится при ЗАКРЫТИИ: человек прочёл и закончил с ним.
 */

const app = (f: string) => readFileSync(join(import.meta.dirname, '../../../app/src', f), 'utf8')
const dialog = app('components/NotificationDialog.tsx')

/** Три места, где показываются уведомления. Поведение должно совпадать. */
const PLACES = [
  ['лента проекта', 'components/ProjectInbox.tsx'],
  ['колокольчик', 'components/NotificationBell.tsx'],
  ['экран «Мне»', 'screens/InboxScreen.tsx'],
] as const

describe('детали уведомления', () => {
  it('окно показывает полный текст, а не обрезанный', () => {
    // Ради него окно и открывают: в карточке текст обрезан многоточием.
    expect(dialog).toMatch(/whitespace-pre-wrap[\s\S]{0,60}?\{notification\.body\}/)
  })

  it('переход предлагается, только когда есть куда идти', () => {
    // Без ссылки normalizeLink подставляет /tasks — кнопка обещала бы то,
    // чего не будет.
    expect(dialog).toMatch(/\{onOpen && \(/)
  })

  it('закрыть можно и клавишей', () => {
    expect(dialog).toMatch(/e\.key === 'Escape'/)
  })
})

describe('поведение одинаково во всех трёх местах', () => {
  for (const [name, file] of PLACES) {
    it(`${name}: клик открывает детали`, () => {
      const src = app(file)
      expect(src, `${name} не показывает окно деталей`).toMatch(/<NotificationDialog/)
      expect(src, `${name}: клик не открывает детали`).toMatch(/onClick=\{\(\) => setDetails\(n\)\}/)
    })

    it(`${name}: прочитанным делает закрытие, а не показ`, () => {
      /**
       * Обработчик бывает как встроенным, так и вынесенным в функцию close —
       * проверяем результат, а не приём: пометка стоит рядом с setDetails(null)
       * и нигде не привязана к самому показу окна.
       */
      const src = app(file)
      const closing =
        /onClose=\{[\s\S]{0,240}?markRead\.mutate\(\{ ids: \[details\.id\] \}\)/.test(src) ||
        /const close = \(\) => \{[\s\S]{0,200}?markRead\.mutate\(\{ ids: \[details\.id\] \}\)/.test(src)
      expect(closing, `${name}: пометка не привязана к закрытию`).toBe(true)
      // И не при открытии: setDetails(n) не должен ничего гасить.
      expect(src, `${name}: клик снова гасит уведомление`).not.toMatch(
        /setDetails\(n\)[\s\S]{0,60}?markRead\.mutate/,
      )
    })

    it(`${name}: без ссылки кнопки перехода нет`, () => {
      const src = app(file)
      expect(src, `${name}: переход предлагается всегда`).toMatch(/details\.link\s*\?/)
    })
  }
})
