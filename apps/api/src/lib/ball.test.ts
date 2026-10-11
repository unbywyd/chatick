import { describe, expect, it } from 'vitest'
import { mayHandoff, openStatusFor, planCompat, planCreate, planHandoff, type BallTask } from './ball.js'

const now = new Date('2026-10-11T12:00:00Z')

const task = (over: Partial<BallTask> = {}): BallTask => ({
  id: 't1',
  projectId: 'p1',
  status: 'in_progress',
  assigneeId: 'doer',
  ownerId: 'boss',
  createdById: 'boss',
  move: 'do',
  round: 1,
  askFromId: null,
  askPrevMove: null,
  waitingClientSince: null,
  ...over,
})

const ok = (r: ReturnType<typeof planHandoff>) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`)
  return r.plan
}

describe('planHandoff', () => {
  it('«На проверку» — мяч владельцу, ход «проверить», в журнале от кого и кому', () => {
    const p = ok(planHandoff(task(), 'review', { actorId: 'doer', note: 'готово, смотри шапку', now }))
    expect(p.patch).toMatchObject({ assigneeId: 'boss', move: 'review', status: 'review', heldSince: now })
    expect(p.handoff).toMatchObject({ action: 'review', fromId: 'doer', toId: 'boss', moveBefore: 'do', moveAfter: 'review', note: 'готово, смотри шапку' })
  })

  it('записка обязательна там, где без неё пинг-понг мутный', () => {
    for (const a of ['review', 'return', 'ask', 'answer', 'cancel'] as const) {
      const t = a === 'answer' ? task({ move: 'answer', askFromId: 'boss', askPrevMove: 'review' }) : a === 'return' ? task({ move: 'review', assigneeId: 'boss' }) : task()
      expect(planHandoff(t, a, { actorId: 'x', to: 'someone', note: '  ' })).toEqual({ ok: false, error: 'note_required' })
    }
    expect(planHandoff(task(), 'pass', { actorId: 'doer', to: 'other' }).ok).toBe(true)
  })

  it('без владельца на проверку не отправить, себе — тоже', () => {
    expect(planHandoff(task({ ownerId: null, createdById: null }), 'review', { actorId: 'doer', note: 'n' })).toEqual({ ok: false, error: 'no_owner' })
    expect(planHandoff(task({ ownerId: 'doer' }), 'review', { actorId: 'doer', note: 'n' })).toEqual({ ok: false, error: 'self' })
  })

  it('владелец по умолчанию — автор, если поля owner ещё нет', () => {
    const p = ok(planHandoff(task({ ownerId: null, createdById: 'author' }), 'review', { actorId: 'doer', note: 'n' }))
    expect(p.patch.assigneeId).toBe('author')
  })

  it('«Принять» закрывает, мяч остаётся у принявшего', () => {
    const p = ok(planHandoff(task({ move: 'review', status: 'review', assigneeId: 'boss' }), 'accept', { actorId: 'boss' }))
    expect(p.patch.status).toBe('done')
    expect(p.patch.assigneeId).toBeUndefined()
  })

  it('«Вернуть» — круг +1, ход «сделать», в работу', () => {
    const p = ok(planHandoff(task({ move: 'review', status: 'review', assigneeId: 'boss', round: 2 }), 'return', { actorId: 'boss', to: 'doer', note: 'кнопка уехала' }))
    expect(p.patch).toMatchObject({ assigneeId: 'doer', move: 'do', status: 'in_progress', round: 3 })
    expect(p.handoff?.round).toBe(3)
    expect(planHandoff(task(), 'return', { actorId: 'boss', to: 'doer', note: 'n' })).toEqual({ ok: false, error: 'wrong_move' })
  })

  it('«Спросить» и «Ответить» возвращают мяч с прежним ходом', () => {
    const onReview = task({ move: 'review', status: 'review', assigneeId: 'boss' })
    const asked = ok(planHandoff(onReview, 'ask', { actorId: 'boss', to: 'designer', note: 'какой цвет?' }))
    expect(asked.patch).toMatchObject({ assigneeId: 'designer', move: 'answer', askFromId: 'boss', askPrevMove: 'review', status: 'review' })

    const waiting = { ...onReview, ...asked.patch } as BallTask
    expect(planHandoff(waiting, 'ask', { actorId: 'designer', to: 'x', note: 'n' })).toEqual({ ok: false, error: 'already_asking' })
    const answered = ok(planHandoff(waiting, 'answer', { actorId: 'designer', note: 'синий' }))
    expect(answered.patch).toMatchObject({ assigneeId: 'boss', move: 'review', status: 'review', askFromId: null, askPrevMove: null })
  })

  it('«Ответить» без вопроса — ошибка', () => {
    expect(planHandoff(task(), 'answer', { actorId: 'doer', note: 'n' })).toEqual({ ok: false, error: 'not_asking' })
  })

  it('«Передать» сохраняет ход; null — в бэклог; «Забрать» — себе', () => {
    const t = task({ move: 'review', status: 'review', assigneeId: 'boss' })
    expect(ok(planHandoff(t, 'pass', { actorId: 'boss', to: 'deputy' })).handoff).toMatchObject({ moveBefore: 'review', moveAfter: 'review', toId: 'deputy' })
    expect(ok(planHandoff(task(), 'pass', { actorId: 'boss', to: null })).patch.assigneeId).toBeNull()
    expect(planHandoff(task(), 'pass', { actorId: 'boss' })).toEqual({ ok: false, error: 'target_required' })
    expect(ok(planHandoff(task(), 'take', { actorId: 'boss' })).patch.assigneeId).toBe('boss')
  })

  it('«Ждём клиента» ставит паузу, ответ клиента снимает', () => {
    const w = ok(planHandoff(task(), 'wait_client', { actorId: 'doer', now }))
    expect(w.patch.waitingClientSince).toEqual(now)
    expect(planHandoff(task({ waitingClientSince: now }), 'wait_client', { actorId: 'doer' })).toEqual({ ok: false, error: 'already_waiting' })
    expect(ok(planHandoff(task({ waitingClientSince: now }), 'client_replied', { actorId: 'doer' })).patch.waitingClientSince).toBeNull()
  })

  it('закрытую трогает только «Открыть заново»', () => {
    const done = task({ status: 'done' })
    expect(planHandoff(done, 'pass', { actorId: 'boss', to: 'x' })).toEqual({ ok: false, error: 'closed' })
    expect(ok(planHandoff(done, 'reopen', { actorId: 'boss' })).patch).toMatchObject({ status: 'todo', move: 'do', assigneeId: 'doer' })
    expect(planHandoff(task(), 'reopen', { actorId: 'boss' })).toEqual({ ok: false, error: 'not_closed' })
  })

  it('«Отменить» с причиной', () => {
    const p = ok(planHandoff(task(), 'cancel', { actorId: 'boss', note: 'клиент передумал' }))
    expect(p.patch.status).toBe('cancelled')
    expect(p.handoff?.note).toBe('клиент передумал')
  })
})

describe('mayHandoff', () => {
  const t = task()
  it('держатель отправляет, спрашивает, передаёт; принять и отменить не может', () => {
    for (const a of ['review', 'ask', 'pass', 'wait_client'] as const) expect(mayHandoff(a, t, 'doer', false)).toBe(true)
    for (const a of ['accept', 'return', 'cancel', 'take', 'reopen'] as const) expect(mayHandoff(a, t, 'doer', false)).toBe(false)
  })
  it('владелец принимает и возвращает; держатель на проверке — тоже', () => {
    expect(mayHandoff('accept', t, 'boss', false)).toBe(true)
    expect(mayHandoff('accept', task({ move: 'review', assigneeId: 'deputy' }), 'deputy', false)).toBe(true)
  })
  it('посторонний — ничего, управляющий — всё', () => {
    for (const a of ['review', 'accept', 'pass', 'cancel'] as const) {
      expect(mayHandoff(a, t, 'stranger', false)).toBe(false)
      expect(mayHandoff(a, t, 'stranger', true)).toBe(true)
    }
  })
  it('отвечает только тот, кого спросили', () => {
    const asked = task({ move: 'answer', assigneeId: 'designer', askFromId: 'boss' })
    expect(mayHandoff('answer', asked, 'designer', false)).toBe(true)
    expect(mayHandoff('answer', asked, 'boss', false)).toBe(false)
  })
})

describe('planCompat — старые клиенты шлют статусы', () => {
  const ctx = { actorId: 'doer', ownerInTeam: true, lastReviewFrom: null, now }

  it('review → мяч владельцу с ходом «проверить», без записки', () => {
    const p = planCompat(task(), { status: 'review' }, ctx)
    expect(p.patch).toMatchObject({ assigneeId: 'boss', move: 'review', status: 'review' })
    expect(p.handoff).toMatchObject({ action: 'review', via: 'compat', note: '' })
  })

  it('review, а владельца в команде нет — мяч остаётся на месте', () => {
    const p = planCompat(task(), { status: 'review' }, { ...ctx, ownerInTeam: false })
    expect(p.patch.assigneeId).toBe('doer')
    expect(p.patch.move).toBe('review')
  })

  it('review с явным исполнителем — проверяет он', () => {
    expect(planCompat(task(), { status: 'review', assigneeId: 'qa' }, ctx).patch.assigneeId).toBe('qa')
  })

  it('review без исполнителя и без владельца — только ход', () => {
    const p = planCompat(task({ assigneeId: null, ownerId: null, createdById: null }), { status: 'review' }, ctx)
    expect(p).toEqual({ patch: { status: 'review', move: 'review' }, handoff: null })
  })

  it('done и verified — принять; cancelled — отменить', () => {
    expect(planCompat(task(), { status: 'done' }, ctx).handoff?.action).toBe('accept')
    expect(planCompat(task(), { status: 'verified' }, ctx).patch.status).toBe('done')
    expect(planCompat(task(), { status: 'cancelled' }, ctx).handoff?.action).toBe('cancel')
  })

  it('из проверки обратно в работу — вернуть отправившему, круг +1', () => {
    const t = task({ move: 'review', status: 'review', assigneeId: 'boss' })
    const p = planCompat(t, { status: 'in_progress' }, { ...ctx, lastReviewFrom: 'doer' })
    expect(p.patch).toMatchObject({ assigneeId: 'doer', move: 'do', status: 'in_progress', round: 2 })
    expect(p.handoff?.action).toBe('return')
    // todo сохраняется как прислали
    expect(planCompat(t, { status: 'todo' }, { ...ctx, lastReviewFrom: 'doer' }).patch.status).toBe('todo')
  })

  it('из закрытой в открытую — открыть заново тем статусом, что прислали', () => {
    const p = planCompat(task({ status: 'done' }), { status: 'in_progress' }, ctx)
    expect(p.handoff?.action).toBe('reopen')
    expect(p.patch).toMatchObject({ status: 'in_progress', move: 'do' })
    const r = planCompat(task({ status: 'done' }), { status: 'review' }, ctx)
    expect(r.patch).toMatchObject({ status: 'review', move: 'review' })
    expect(r.handoff?.moveAfter).toBe('review')
  })

  it('todo ↔ in_progress — не передача', () => {
    expect(planCompat(task({ status: 'todo' }), { status: 'in_progress' }, ctx)).toEqual({ patch: { status: 'in_progress' }, handoff: null })
  })

  it('смена исполнителя — передать тем же ходом', () => {
    const p = planCompat(task({ move: 'review', status: 'review', assigneeId: 'boss' }), { assigneeId: 'deputy' }, ctx)
    expect(p.handoff).toMatchObject({ action: 'pass', fromId: 'boss', toId: 'deputy', moveAfter: 'review' })
    expect(planCompat(task(), { assigneeId: 'doer' }, ctx)).toEqual({ patch: {}, handoff: null })
  })

  it('done с новым исполнителем — закрыть и записать исполнителя', () => {
    const p = planCompat(task(), { status: 'done', assigneeId: 'boss' }, ctx)
    expect(p.patch).toMatchObject({ status: 'done', assigneeId: 'boss' })
    expect(p.handoff?.toId).toBe('boss')
  })
})

describe('planCreate', () => {
  it('владелец = автор, на человека — строка «создал»', () => {
    const r = planCreate({ assigneeId: 'doer', createdById: 'boss' }, { actorId: 'boss', now })
    expect(r.fields).toMatchObject({ status: 'todo', move: 'do', ownerId: 'boss', heldSince: now })
    expect(r.handoff).toMatchObject({ action: 'create', toId: 'doer', fromId: null })
  })
  it('без исполнителя — бэклог, без строки журнала', () => {
    const r = planCreate({ createdById: 'boss' }, { actorId: 'boss' })
    expect(r.fields.heldSince).toBeNull()
    expect(r.handoff).toBeNull()
  })
  it('сразу на проверку — ход «проверить»; verified — done', () => {
    expect(planCreate({ status: 'review', assigneeId: 'boss' }, { actorId: 'x' }).fields.move).toBe('review')
    expect(planCreate({ status: 'verified' }, { actorId: 'x' }).fields.status).toBe('done')
  })
})

describe('openStatusFor', () => {
  it('выводит статус из хода', () => {
    expect(openStatusFor('review', 'todo')).toBe('review')
    expect(openStatusFor('do', 'todo')).toBe('todo')
    expect(openStatusFor('do', 'review')).toBe('in_progress')
    expect(openStatusFor('answer', 'review')).toBe('review')
    expect(openStatusFor('answer', 'done')).toBe('in_progress')
  })
})
