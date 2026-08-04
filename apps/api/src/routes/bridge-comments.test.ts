import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Комментарии задачи через мост.
//
// Ассистент участвует в обсуждении наравне с людьми, и ровно поэтому здесь
// легко получить три тихих поломки, каждую из которых видно только в проде:
//
//   1. чтение без проверки проекта — туннель в один проект читает чужие
//      обсуждения (id задачи виден в любой ссылке, угадывать нечего);
//   2. ответ без replyTo — ветка превращается в плоский список;
//   3. запись без уведомлений — комментарий появляется молча, и человек
//      узнаёт о нём, только зайдя в задачу.
//
// Всё три ловятся по исходнику: проверки стоят в коде ручки, а не в типах.

const src = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')
const docs = readFileSync(join(import.meta.dirname, '../lib/bridge-docs.ts'), 'utf8')

/** Тело ручки от её объявления до следующего объявления моста. */
function handler(method: string, path: string): string {
  const start = src.indexOf(`bridgeRoute.${method}('${path}'`)
  expect(start, `ручка ${method.toUpperCase()} ${path} не найдена`).toBeGreaterThan(-1)
  const rest = src.slice(start + 20)
  const end = rest.indexOf('bridgeRoute.')
  return rest.slice(0, end === -1 ? undefined : end)
}

describe('GET /x/tasks/:id/comments', () => {
  const body = handler('get', '/tasks/:id/comments')

  it('ограничивает выборку проектом туннеля', () => {
    expect(body).toMatch(/eq\(taskComments\.projectId, scope\.projectId\)/)
  })

  it('требует право видеть задачи', () => {
    expect(body).toMatch(/require\(c as never, 'tasks\.read'/)
  })

  it('отдаёт ветку: у ответа виден родитель', () => {
    expect(body).toMatch(/replyTo:/)
  })

  it('отдаёт автора по id, а не только по имени — иначе на него не сослаться', () => {
    expect(body).toMatch(/authorId:/)
  })
})

describe('POST /x/tasks/:id/comments', () => {
  const body = handler('post', '/tasks/:id/comments')

  it('принимает ответ на конкретный комментарий', () => {
    expect(body).toMatch(/b\.replyTo/)
  })

  it('проверяет, что родитель — из этой же задачи и этого проекта', () => {
    expect(body).toMatch(/eq\(taskComments\.taskId, taskId\)/)
    expect(body).toMatch(/eq\(taskComments\.projectId, scope\.projectId\)/)
  })

  it('пишет комментарий только в задачу своего проекта', () => {
    expect(body).toMatch(/eq\(tasks\.projectId, scope\.projectId\)/)
  })

  it('уведомляет упомянутых', () => {
    expect(body).toMatch(/extractMentions\(text\)/)
    expect(body).toMatch(/event: 'comment_mention'/)
  })

  it('уведомляет автора задачи, исполнителя и того, кому отвечают', () => {
    expect(body).toMatch(/event: 'task_comment'/)
    expect(body).toMatch(/task\.assigneeId/)
    expect(body).toMatch(/task\.createdById/)
  })

  it('не уведомляет самого себя', () => {
    expect(body).toMatch(/x !== id\.userId/)
  })

  it('ограничивает длину текста', () => {
    expect(body).toMatch(/text\.length > 10_000/)
  })

  it('принимает вложения — скриншот часто и есть весь ответ', () => {
    expect(body).toMatch(/attachmentIds/)
    expect(body).toMatch(/set\(\{ commentId: row!\.id, taskId, pendingUntil: null \}\)/)
  })

  it('привязывает только свои файлы своего проекта', () => {
    expect(body).toMatch(/eq\(files\.projectId, scope\.projectId\)/)
    expect(body).toMatch(/eq\(files\.uploadedById, id\.userId\)/)
  })

  it('одних файлов достаточно — текст можно не писать', () => {
    expect(body).toMatch(/!text && !attachmentIds\.length/)
  })
})

describe('чего мосту не дают', () => {
  it('нет правки и удаления комментариев', () => {
    expect(src).not.toMatch(/bridgeRoute\.(patch|delete)\('\/tasks\/:id\/comments/)
  })
})

describe('гайд для ассистента', () => {
  it('описывает ответ на комментарий', () => {
    expect(docs).toMatch(/replyTo/)
  })

  it('объясняет разметку упоминания — без неё @имя остаётся просто текстом', () => {
    expect(docs).toMatch(/@\\\[Their Name\\\]\(<userId>\)|@\[Their Name\]\(<userId>\)/)
  })

  it('говорит, что удалять и править комментарии нельзя', () => {
    expect(docs).toMatch(/Editing\s+and deleting comments/)
  })

  it('описывает вложения', () => {
    expect(docs).toMatch(/attachmentIds/)
    expect(docs).toMatch(/Attaching files/)
  })
})
