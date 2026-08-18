import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { commentWatchers } from './notify.js'

// Кому уходит «новый комментарий к задаче» (SPEC §8.9).
//
// Автора задачи в получатели добавили не зря: «поставил задачу Талю, Таль
// перевёл в ревью — и я не узнаю, хотя ревью ждут от меня». Но правило было
// слишком широким: когда двое переписываются между собой («@исполнитель,
// сделано?»), автора дёргали за разговор, в котором его нет.

const AUTHOR = 'u-author'
const ASSIGNEE = 'u-assignee'
const THIRD = 'u-third'
const OUTSIDER = 'u-outsider'

const call = (mentioned: string[], actorId = THIRD) =>
  commentWatchers({ assigneeId: ASSIGNEE, createdById: AUTHOR, mentioned, actorId })

describe('исполнителю — всегда', () => {
  it('без упоминаний', () => {
    expect(call([])).toContain(ASSIGNEE)
  })

  it('и когда обращаются к другому', () => {
    // Задача на нём: обсуждение в ней его работа, кому бы ни было адресовано.
    expect(call([OUTSIDER])).toContain(ASSIGNEE)
  })
})

describe('автору — только когда разговор не адресован другому', () => {
  it('упоминаний нет — уведомляем', () => {
    // «Нет упоминаний» это НЕ «не адресовано»: обычное обсуждение по делу
    // идёт без них, и таких комментариев на проде больше половины.
    expect(call([])).toContain(AUTHOR)
  })

  it('упомянут кто-то другой — молчим', () => {
    // Ровно тот случай, с которого начали: «@Daniel, сделано?» автору задачи
    // не адресовано.
    expect(call([ASSIGNEE])).not.toContain(AUTHOR)
    expect(call([OUTSIDER])).not.toContain(AUTHOR)
  })

  it('упомянут сам автор — comment_mention, а не task_comment', () => {
    // Он получит своё уведомление об упоминании; второе было бы дублем.
    expect(call([AUTHOR])).not.toContain(AUTHOR)
  })

  it('упомянут автор И другой — тоже не дублируем', () => {
    expect(call([AUTHOR, OUTSIDER])).not.toContain(AUTHOR)
  })
})

describe('себе не шлём', () => {
  it('автор пишет в своей задаче', () => {
    expect(commentWatchers({ assigneeId: ASSIGNEE, createdById: AUTHOR, mentioned: [], actorId: AUTHOR })).toEqual([ASSIGNEE])
  })

  it('исполнитель пишет сам', () => {
    expect(commentWatchers({ assigneeId: ASSIGNEE, createdById: AUTHOR, mentioned: [], actorId: ASSIGNEE })).toEqual([AUTHOR])
  })
})

describe('крайние случаи', () => {
  it('без исполнителя и без автора — пусто', () => {
    expect(commentWatchers({ assigneeId: null, createdById: null, mentioned: [], actorId: THIRD })).toEqual([])
  })

  it('автор и исполнитель — один человек: один раз', () => {
    // Иначе notify получит его дважды и дедуп ляжет на другой слой.
    expect(commentWatchers({ assigneeId: AUTHOR, createdById: AUTHOR, mentioned: [], actorId: THIRD })).toEqual([AUTHOR])
  })

  it('тот, кому отвечают, добавляется — это отдельная сторона', () => {
    const got = commentWatchers({
      assigneeId: ASSIGNEE, createdById: AUTHOR, replyToAuthorId: OUTSIDER, mentioned: [], actorId: THIRD,
    })
    expect(got).toContain(OUTSIDER)
  })
})

describe('правило одно на все три пути', () => {
  const here = import.meta.dirname
  const read = (p: string) => readFileSync(join(here, p), 'utf8')

  it('интерфейс, мост и ассистент зовут общую функцию', () => {
    // Раньше правило было выписано в каждом заново — разойтись им ничего не
    // мешало, и ассистент дёргал бы там, где интерфейс уже молчит.
    for (const [name, src] of [
      ['tasks', read('../routes/tasks.ts')],
      ['bridge', read('../routes/bridge.ts')],
      ['memory', read('./memory.ts')],
    ] as const) {
      expect(src, name).toMatch(/commentWatchers\(\{/)
      // И ни одного своего вычисления получателей КОММЕНТАРИЯ рядом.
      // (task_status считает своих отдельно — там правило другое.)
      expect(src, name).not.toMatch(/const watchers = \[/)
    }
  })
})
