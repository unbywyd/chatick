import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Индикаторы в чате гаснут ПО ФАКТУ, а не по факту доставки события.
//
// Оба индикатора — «Проверяется…» и «ИИ думает…» — однажды зависали навсегда,
// и по одной причине: их гасило ws-событие, а событие может не дойти
// (переподключение, потерянный кадр, свёрнутая вкладка, перезапуск сервера).
// Ответ при этом приезжает подгрузкой истории, и человек видит ответ вместе с
// крутящимся спиннером, а поле ввода заблокировано.
//
// Гонку не воспроизвести по требованию — тем важнее, чтобы правку не откатили
// как «непонятно зачем».

const here = import.meta.dirname
const panel = readFileSync(join(here, '../../../app/src/components/chat/ChatPanel.tsx'), 'utf8')

describe('индикаторы гаснут по факту, а не по ws-событию', () => {
  it('«Проверяется…» смотрит на доставленное сообщение', () => {
    expect(panel).toMatch(/if \(m\?\.status === 'delivered'\) setMyPending\(null\)/)
  })

  it('«ИИ думает…» гаснет от появления ответа в ленте', () => {
    // Раньше setAiThinking(false) стоял ТОЛЬКО в onWsMessage.
    expect(panel).toMatch(/if \(lastAi && !lastAi\.author\) setAiThinking\(false\)/)
  })

  it('ответ ищется по последнему сообщению, а не по их количеству', () => {
    // История догружается пачками вверх, и счётчик растёт без всякого ответа —
    // спиннер гас бы от прокрутки назад.
    expect(panel).toMatch(/const lastAi = aiMessages\[aiMessages\.length - 1\]/)
    const fx = panel.slice(panel.indexOf('const lastAi ='))
    const body = fx.slice(0, fx.indexOf('}, ['))
    expect(body).not.toMatch(/aiMessages\.length >/)
  })

  it('страховочный таймер остался', () => {
    // Ответа может не быть вовсе — тогда гасит он, иначе ввод заблокирован
    // навсегда. Это последний рубеж, а не основной способ.
    expect(panel).toMatch(/setTimeout\(\(\) => setAiThinking\(false\), 90_000\)/)
  })
})
