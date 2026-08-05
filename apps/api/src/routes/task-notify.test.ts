import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Уведомления о назначении задачи.
//
// «Вам назначили задачу» перестаёт быть правдой в тот момент, когда задачу
// переназначили на другого или удалили. Раньше уведомление продолжало висеть в
// колокольчике: человек открывал его и обнаруживал задачу, к которой уже не
// имеет отношения.
//
// Вторая половина той же беды — журнал дедупа. Ключ `task_assigned:<task>:<user>`
// оставался навсегда, поэтому повторное назначение ТОЙ ЖЕ задачи ТОМУ ЖЕ
// человеку проходило молча: второе уведомление не создавалось никогда.
//
// Обе точки — снятие и удаление — есть и в интерфейсе, и в мосту, и разойтись
// им нельзя: пропущенная означает висящее уведомление в проде.

const tasks = readFileSync(join(import.meta.dirname, 'tasks.ts'), 'utf8')
const bridge = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')
const notify = readFileSync(join(import.meta.dirname, '../lib/notify.ts'), 'utf8')

function handler(src: string, marker: string): string {
  const start = src.indexOf(marker)
  expect(start, `не найдено: ${marker}`).toBeGreaterThan(-1)
  const rest = src.slice(start + marker.length)
  const end = rest.search(/\n(tasksRoute|bridgeRoute)\./)
  return rest.slice(0, end === -1 ? undefined : end)
}

describe('снятие уведомления', () => {
  it('удаляет только НЕпрочитанное — прочитанное человек уже видел', () => {
    expect(notify).toMatch(/isNull\(notifications\.readAt\)/)
  })

  it('чистит журнал дедупа, иначе повторное назначение пройдёт молча', () => {
    const fn = notify.slice(notify.indexOf('export async function dropNotice'))
    expect(fn).toMatch(/delete\(notificationLog\)/)
  })

  it('пересчитывает колокольчик у получателя', () => {
    const fn = notify.slice(notify.indexOf('export async function dropNotice'))
    expect(fn).toMatch(/sendToUserAnywhere\(opts\.userId, 'notification'/)
  })

  it('трогает уведомления только этого человека и этой задачи', () => {
    const fn = notify.slice(notify.indexOf('export async function dropNotice'))
    expect(fn).toMatch(/eq\(notifications\.userId, opts\.userId\)/)
    expect(fn).toMatch(/eq\(notifications\.entityId, opts\.entityId\)/)
  })
})

describe('интерфейс', () => {
  it('переназначили — прежнему исполнителю уведомление снимаем', () => {
    // Именно PATCH задачи. Раньше брали первый попавшийся tasksRoute.patch(,
    // и появившаяся рядом ручка порядка забрала срез себе: тест оставался
    // зелёным на коде, где снятие уведомления удалено.
    const patchTask = tasks.slice(tasks.search(/tasksRoute\.patch\(\s*'\/:taskId'/))
    expect(handler(patchTask, 'tasksRoute.patch(')).toMatch(/unassignNotice\(task\.assigneeId, task\.id\)/)
  })

  it('удалили задачу — тоже снимаем: ссылка вела бы в пустоту', () => {
    expect(handler(tasks, "tasksRoute.delete('/:taskId'")).toMatch(/unassignNotice\(task\.assigneeId, task\.id\)/)
  })
})

describe('мост', () => {
  it('назначение при создании уведомляет — раньше задача сваливалась молча', () => {
    expect(handler(bridge, "bridgeRoute.post('/tasks'")).toMatch(/notifyTask\(/)
  })

  it('переназначение уведомляет нового и снимает у прежнего', () => {
    const body = handler(bridge, "bridgeRoute.patch('/tasks/:id'")
    expect(body).toMatch(/notifyTask\(/)
    expect(body).toMatch(/unassignNotice\(existing\.assigneeId, existing\.id\)/)
  })

  it('удаление задачи снимает уведомление', () => {
    expect(handler(bridge, "bridgeRoute.delete('/tasks/:id'")).toMatch(/unassignNotice\(existing\.assigneeId, existing\.id\)/)
  })
})

describe('ключ дедупа один на все точки', () => {
  it('снятие использует тот же ключ, что и создание', () => {
    expect(tasks).toMatch(/dedupeKey: `task_assigned:\$\{task\.id\}:\$\{task\.assigneeId\}`/)
    expect(tasks).toMatch(/dedupeKey: `task_assigned:\$\{taskId\}:\$\{userId\}`/)
  })
})
