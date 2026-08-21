import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * «Показать вводный тур» из меню действительно его показывает.
 *
 * Пункт сбрасывает отметку в базе, а решение показывать тур зависит ещё от
 * двух флагов в памяти страницы: tourHidden («закрыл щелчком мимо») и greeted
 * («приветствие уже было»). Их никто не обнулял.
 *
 * Человек, закрывший тур щелчком мимо, нажимал «показать заново» — и не видел
 * ничего: сервер отвечал «не показан», а локальное «спрятан» оставалось.
 * Кнопка выглядела мёртвой, хотя всё честно отрабатывало.
 */

const app = (f: string) => readFileSync(join(import.meta.dirname, '../../../app/src', f), 'utf8')
const screen = app('screens/ProjectScreen.tsx')
const menu = app('components/ProfileMenu.tsx')

describe('повторный показ тура', () => {
  it('экран слушает сигнал и чистит локальные флаги', () => {
    const listener = screen.match(/const replay = \(\) => \{[\s\S]{0,200}?\}/)?.[0] ?? ''
    expect(listener, 'обработчик повторного показа пропал').not.toBe('')
    expect(listener).toMatch(/setTourHidden\(false\)/)
    expect(listener).toMatch(/setGreeted\(false\)/)
    expect(screen).toMatch(/addEventListener\('chatick:tour-replay'/)
    expect(screen, 'подписка не снимается').toMatch(/removeEventListener\('chatick:tour-replay'/)
  })

  it('меню шлёт этот сигнал', () => {
    /**
     * Следить за сменой отметки в базе бесполезно: у того, кто закрыл тур в
     * этом же сеансе, она уже пустая — серверу нечего менять, и перехода
     * «нельзя → можно» не возникает. Экран так ничего и не узнаёт.
     */
    expect(menu).toMatch(/dispatchEvent\(new CustomEvent\('chatick:tour-replay'\)\)/)
  })

  it('тур начинается с того, что человек видит', () => {
    /**
     * Панель открывается на «Моих задачах». Раньше первым шагом шёл чат, и
     * тур первым же действием уводил с задач — спорил с собственным
     * умолчанием и оставлял человека в другом месте.
     */
    const steps = screen.slice(screen.indexOf('const tourSteps'))
    const first = steps.indexOf("key: 'myTasks'")
    const chat = steps.indexOf("key: 'chat'")
    expect(first, 'шага про мои задачи нет').toBeGreaterThan(-1)
    expect(first, 'чат снова идёт раньше задач').toBeLessThan(chat)
    expect(screen, 'первый шаг не открывает задачи').toMatch(/chatRef\.current\?\.showTasks\(\)/)
  })

  it('шаг тура умеет открыть чат', () => {
    /**
     * Панель стартует на «Моих задачах», где композера нет вовсе. Первый шаг
     * целится в поле ввода, и без открытия чата цель не находится — Tour
     * возвращает null, то есть не показывается совсем, молча.
     */
    expect(screen).toMatch(/chatRef\.current\?\.focusChat\(\)/)
  })

  it('chatRef объявлен раньше шагов, которые им пользуются', () => {
    /**
     * Стоял ниже — и шаги захватывали его замыкание пустым: before() молча
     * ничего не делал. Типы такого не ловят, обращение внутри стрелочной
     * функции.
     */
    const ref = screen.indexOf('const chatRef = useRef<ChatPanelHandle>(null)')
    const steps = screen.indexOf('const tourSteps: TourStep[] = useMemo(')
    expect(ref, 'chatRef не найден').toBeGreaterThan(-1)
    expect(steps, 'шаги тура не найдены').toBeGreaterThan(-1)
    expect(ref, 'chatRef снова объявлен после шагов тура').toBeLessThan(steps)
  })

  it('пункт меню обновляет данные о себе', () => {
    // Без инвалидации ответ лежал бы в кэше ещё пять минут (staleTime), и
    // тур не узнал бы о сбросе.
    expect(menu).toMatch(/tour-reset[\s\S]{0,200}?invalidateQueries\(\{ queryKey: \['me'\] \}\)/)
  })
})
