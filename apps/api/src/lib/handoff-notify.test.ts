import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HANDOFF_ACTIONS } from '../db/schema.js'
import { handoffRecipients } from './handoff-notify.js'

const h = (action: (typeof HANDOFF_ACTIONS)[number], over: Partial<{ actorId: string; fromId: string; toId: string }> = {}) => ({
  action,
  actorId: 'actor',
  fromId: 'from',
  toId: 'to',
  ...over,
})

describe('handoffRecipients — одно уведомление тому, от кого теперь ждут', () => {
  it('ход с передачей — новому держателю', () => {
    for (const a of ['review', 'return', 'ask', 'answer', 'pass', 'reopen'] as const) expect(handoffRecipients(h(a), null)).toEqual(['to'])
  })
  it('принять — тому, кто сдавал работу', () => {
    expect(handoffRecipients(h('accept'), 'doer')).toEqual(['doer'])
    expect(handoffRecipients(h('accept'), null)).toEqual([])
  })
  it('отменить и забрать — прежнему держателю', () => {
    expect(handoffRecipients(h('cancel'), null)).toEqual(['from'])
    expect(handoffRecipients(h('take'), null)).toEqual(['from'])
  })
  it('пауза и создание — никому', () => {
    for (const a of ['wait_client', 'client_replied', 'create'] as const) expect(handoffRecipients(h(a), null)).toEqual([])
  })
  it('себе не пишем', () => {
    expect(handoffRecipients(h('pass', { toId: 'actor' }), null)).toEqual([])
    expect(handoffRecipients(h('cancel', { fromId: 'actor' }), null)).toEqual([])
  })
})

describe('заголовки передач', () => {
  const src = readFileSync(join(__dirname, 'notify.ts'), 'utf8')
  const blocks = ['  en: {', '  ru: {', '  he: {'].map((start) => {
    const i = src.indexOf(start)
    return src.slice(i, src.indexOf('\n  },', i))
  })
  it('у каждого хода, о котором уведомляем, есть заголовок на всех языках', () => {
    for (const a of ['review', 'accept', 'return', 'ask', 'answer', 'pass', 'take', 'cancel', 'reopen']) {
      for (const b of blocks) expect(b, `handoff_${a}`).toContain(`handoff_${a}:`)
    }
    for (const b of blocks) expect(b).toContain('task_handoff:')
  })
})
