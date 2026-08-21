import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Свёрнутый чат и переключатель каналов.
//
// В проект заходят работать с задачами, а разговор открывают, когда он нужен.
// Развёрнутая панель отнимала половину экрана у того, кто пришёл на доску.

const app = (p: string) => readFileSync(join(import.meta.dirname, '../../../app/src', p), 'utf8')
const panel = app('components/chat/ChatPanel.tsx')
const screen = app('screens/ProjectScreen.tsx')
const hook = app('hooks/useChatCollapsed.ts')
const messages = readFileSync(join(import.meta.dirname, 'messages.ts'), 'utf8')

describe('чат сворачивается', () => {
  it('по умолчанию свёрнут', () => {
    // Пусто в хранилище читается как «да»: иначе первый заход в проект
    // встречал бы половиной экрана под разговор, которого ещё нет.
    expect(hook).toMatch(/!== '0'/)
  })

  it('состояние переживает перезагрузку', () => {
    expect(hook).toMatch(/localStorage/)
  })

  it('на узком экране не сворачивается', () => {
    // Ниже 1280px чат — вкладка во весь экран. «Свернуть» оставляло полосу в
    // 56px с аватарками вместо переписки: экран пустой, а чата нет.
    expect(screen).toMatch(/const chatCollapsed = chatCollapsedPref && wide/)
  })

  it('кнопки сворачивания там тоже нет', () => {
    // Кнопка предлагала действие, после которого оставалась пустая полоса.
    const at = panel.indexOf("title={t('chat.collapse')}")
    expect(at, 'кнопка не найдена').toBeGreaterThan(-1)
    expect(panel.slice(at, at + 200)).toMatch(/hidden xl:inline-flex/)
  })

  it('колонка сужается вместе с панелью', () => {
    // Иначе рядом со свёрнутым чатом остаётся пустое место в треть экрана.
    expect(screen).toMatch(/chatCollapsed \? '56px'/)
  })

  it('ручку перетаскивания в свёрнутом виде убираем', () => {
    // Тянуть полосу шириной с иконку некуда, а перетаскивание боролось бы с
    // заданной шириной и оставляло колонку в промежуточном состоянии.
    expect(screen).toMatch(/\{!chatCollapsed && \(/)
  })
})

describe('в полосе — только то, ради чего заглядывают', () => {
  it('бейдж поверх иконки', () => {
    // Свёрнутая полоса должна отвечать «есть ли новое» без единого клика.
    const at = panel.indexOf('if (collapsed) {')
    expect(at, 'свёрнутый вид не найден').toBeGreaterThan(-1)
    const body = panel.slice(at, at + 5000)
    expect(body).toMatch(/total > 0 &&/)
    expect(body).toMatch(/99\+/)
  })

  it('счётчик онлайна на месте', () => {
    const body = panel.slice(panel.indexOf('if (collapsed) {'), panel.indexOf('if (collapsed) {') + 5000)
    expect(body).toMatch(/online\.length/)
  })

  it('аватарки столбиком, не больше десяти', () => {
    // Полоса высокая, но не бесконечная; остаток честнее свести в «+N».
    const body = panel.slice(panel.indexOf('if (collapsed) {'), panel.indexOf('if (collapsed) {') + 5000)
    expect(body).toMatch(/slice\(0, 10\)/)
    expect(body).toMatch(/length > 10 &&/)
  })

  it('чат внизу, стрелка вверху', () => {
    // Симметрия с сайдбаром: стрелка раскрытия — на том же месте, что у него.
    // Иконка чата прижата к низу, к полю ввода развёрнутой панели: рука идёт
    // туда же, куда пойдёт печатать.
    const body = panel.slice(panel.indexOf('if (collapsed) {'), panel.indexOf('if (collapsed) {') + 5000)
    expect(body).toMatch(/mt-auto/)
    // Стрелка раньше иконки чата в разметке — значит выше на экране.
    expect(body.indexOf('PanelRightClose')).toBeLessThan(body.indexOf('MessagesSquare'))
  })

  it('бейдж только на нижней кнопке', () => {
    // На двух кнопках подряд одно и то же число читалось бы как две разные
    // величины.
    const body = panel.slice(panel.indexOf('if (collapsed) {'), panel.indexOf('if (collapsed) {') + 5000)
    expect((body.match(/total > 0 &&/g) ?? []).length).toBe(1)
  })

  it('поиска и меню действий в полосе нет', () => {
    // Они нужны внутри разговора, а не вместо него.
    const body = panel.slice(panel.indexOf('if (collapsed) {'), panel.indexOf('if (collapsed) {') + 5000)
    expect(body).not.toMatch(/chatSearch\.title/)
    expect(body).not.toMatch(/MoreHorizontal/)
  })
})

describe('переключатель читается как переключатель', () => {
  it('равные доли в общей подложке', () => {
    // Прежний вид — кнопки в ряд — не говорил, что это каналы, а не действия.
    // Долей стало три: к чату и ассистенту добавились мои задачи.
    expect(panel).toMatch(/grid-cols-3/)
    expect(panel).toMatch(/ModeTab/)
  })

  it('переключатель виден и там, где нет поля ввода', () => {
    /**
     * Он жил внутри composer'а, под полем. На виде «Мои задачи» поля нет —
     * писать в задачу из чата нельзя, — и вместе с composer'ом исчез бы и
     * переключатель: уйти со списка было бы нечем.
     */
    const footerEnd = panel.indexOf('</footer>')
    expect(footerEnd, 'composer не найден').toBeGreaterThan(-1)
    expect(panel.indexOf('grid-cols-3'), 'переключатель снова внутри composer').toBeGreaterThan(footerEnd)
  })

  it('подложка переключателя темнее самих табов', () => {
    /**
     * Активный таб красится в bg-background. Была и подложка bg-background —
     * в тёмной теме это одна и та же яркость (0.15), и отличить активный
     * было нельзя вовсе.
     */
    const bar = panel.match(/data-tour="modes"[^>]*/)?.[0] ?? ''
    expect(bar, 'полоса переключателя не найдена').not.toBe('')
    expect(bar, 'подложка снова сливается с активным табом').not.toMatch(/bg-background/)
    expect(bar).toMatch(/bg-secondary/)
  })

  it('активная половина поднята, спящая утоплена', () => {
    const at = panel.indexOf('function ModeTab(')
    const body = panel.slice(at, at + 1400)
    expect(body).toMatch(/bg-background text-foreground shadow-sm/)
  })

  it('бейдж на каждом канале свой', () => {
    // Чат и ассистент — разные разговоры: открыв одного, второй не прочитан.
    expect(panel).toMatch(/badge=\{unread\.data\?\.group/)
    expect(panel).toMatch(/badge=\{unread\.data\?\.ai/)
  })

  it('молния убрана из интерфейса', () => {
    // Ею почти не пользовались, а место занимала рядом с самым частым
    // действием. Свойство осталось: сервер понимает, мост пользуется, старые
    // сообщения помечены — убрана только кнопка.
    expect(panel).not.toMatch(/setBypassAi/)
    expect(panel).not.toMatch(/<Zap /)
    // Пометка в ленте на месте: старые сообщения не должны потерять признак.
    expect(panel).toMatch(/message\.rawSend &&/)
  })
})

describe('счёт непрочитанного', () => {
  it('своё не считается', () => {
    // Иначе бейдж загорался от того, что человек только что написал сам.
    const at = messages.indexOf("messagesRoute.get('/unread'")
    expect(at, 'ручка не найдена').toBeGreaterThan(-1)
    expect(messages.slice(at, at + 1800)).toMatch(/ne\(messages\.authorId, sub\)/)
  })

  it('каналы считаются раздельно', () => {
    const at = messages.indexOf("messagesRoute.get('/unread'")
    const body = messages.slice(at, at + 1800)
    expect(body).toMatch(/lastSeenGroupAt/)
    expect(body).toMatch(/lastSeenAiAt/)
  })

  it('чужие ответы ассистента не мои', () => {
    // Личный канал адресный: ответ другому человеку меня не касается.
    const at = messages.indexOf("messagesRoute.get('/unread'")
    expect(messages.slice(at, at + 1800)).toMatch(/recipientId/)
  })

  it('время отметки ставит сервер', () => {
    // Часы на устройстве могут врать, и отметка из будущего спрятала бы всё
    // последующее.
    const at = messages.indexOf("messagesRoute.post('/seen'")
    expect(at).toBeGreaterThan(-1)
    expect(messages.slice(at, at + 700)).toMatch(/new Date\(\)/)
  })

  it('свёрнутый чат не гасит бейдж', () => {
    // Он не открыт — гасить значило бы соврать: человек ничего не увидел.
    expect(panel).toMatch(/if \(collapsed\) return\s*\n\s*markSeen\(mode\)/)
  })
})
