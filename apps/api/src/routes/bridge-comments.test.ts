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
    // Область проекта проверяется либо здесь, либо в taskByKey — он ищет
    // строго внутри scope.projectId. Важна гарантия, а не написание.
    expect(body).toMatch(/eq\(tasks\.projectId, scope\.projectId\)|taskByKey\(scope\.projectId/)
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

describe('номер задачи работает везде одинаково', () => {
  // Ассистент оперирует «TASK-2», а не идентификатором: номер он видит в
  // задаче, в ссылке и в ответе моста. Стоит одной ручке принять номер, а
  // соседней — нет, и они расходятся молча, без ошибки.
  //
  // Так и было: POST разрешал номер и создавал комментарий, GET искал
  // комментарии с taskId = 'TASK-2' и возвращал пустой список. Запись
  // отвечала успехом, чтение — пустотой; выглядело как потеря данных.

  it('чтение и запись комментариев разрешают ключ одинаково', () => {
    expect(handler('get', '/tasks/:id/comments')).toMatch(/taskByKey\(scope\.projectId/)
    expect(handler('post', '/tasks/:id/comments')).toMatch(/taskByKey\(scope\.projectId/)
  })

  it('ни одна ручка задачи не ищет по сырому параметру', () => {
    // Сторож класса: сырой c.req.param('id') в условии по taskId — это ровно
    // тот баг. Ручки задач обязаны разрешать номер, а не сравнивать строку.
    const routes = [...src.matchAll(/bridgeRoute\.(get|post|patch|delete)\('(\/tasks\/:id[^']*)'/g)]
    expect(routes.length).toBeGreaterThan(5)

    const raw = routes
      .map(([, method, path]) => ({ method: method!, path: path!, body: handler(method!, path!) }))
      .filter((r) => /eq\(\s*\w+\.taskId,\s*c\.req\.param\('id'\)/.test(r.body))
      .map((r) => `${r.method.toUpperCase()} ${r.path}`)

    expect(raw, `ищут по сырому параметру вместо taskByKey: ${raw.join(', ')}`).toEqual([])
  })
})

describe('правка и удаление: автор или админ', () => {
  // То же правило, что в интерфейсе. Мост работает от имени человека, значит
  // «своё» — это своё у него, а не «всё, что написал ассистент».
  const patch = handler('patch', '/tasks/:id/comments/:commentId')
  const del = handler('delete', '/tasks/:id/comments/:commentId')

  it('обе ручки спрашивают право по автору комментария', () => {
    // Через общую commentForWrite — правило должно быть одно на обе.
    expect(patch).toMatch(/commentForWrite\(/)
    expect(del).toMatch(/commentForWrite\(/)
    const rule = src.slice(src.indexOf('async function commentForWrite'))
    expect(rule).toMatch(/ownerOrAdmin\(scope\.projectId, auth\(c\)\.userId, row\.authorId\)/)
  })

  it('чужой комментарий без прав — 403, а не молчаливый отказ', () => {
    const rule = src.slice(src.indexOf('async function commentForWrite'))
    expect(rule).toMatch(/status: 403/)
  })

  it('не выходит за пределы проекта туннеля', () => {
    const rule = src.slice(src.indexOf('async function commentForWrite'))
    expect(rule).toMatch(/eq\(taskComments\.projectId, scope\.projectId\)/)
  })

  it('правка проходит ту же разметку, что и создание', () => {
    // Иначе упоминание, добавленное при правке, осталось бы текстом и
    // человека бы не позвали.
    expect(patch).toMatch(/richText\(text\)/)
  })

  it('правка держит тот же предел длины', () => {
    expect(patch).toMatch(/text\.length > 10_000/)
  })

  it('автор — это автор, а не любой участник', () => {
    // Сторож смысла: если условие про authorId пропадёт, править сможет
    // каждый, у кого есть tasks.read.
    const rule = src.slice(src.indexOf('async function ownerOrAdmin'))
    expect(rule).toMatch(/authorId && authorId === userId/)
  })
})

describe('гайд для ассистента', () => {
  it('описывает ответ на комментарий', () => {
    expect(docs).toMatch(/replyTo/)
  })

  it('объясняет разметку упоминания — без неё @имя остаётся просто текстом', () => {
    expect(docs).toMatch(/@\\\[Their Name\\\]\(<userId>\)|@\[Their Name\]\(<userId>\)/)
  })

  it('описывает правку и удаление вместе с правилом', () => {
    expect(docs).toMatch(/PATCH\s+\/x\/tasks\/<id>\/comments\/<commentId>/)
    expect(docs).toMatch(/DELETE \/x\/tasks\/<id>\/comments\/<commentId>/)
    expect(docs).toMatch(/the author\s+changes their own, an admin changes any/)
  })

  it('предупреждает, что удаление комментария необратимо', () => {
    // У задачи есть корзина на 7 дней, у комментария — нет. Ассистент должен
    // знать разницу до того, как сотрёт чужую мысль.
    expect(docs).toMatch(/Deleting a comment is permanent/)
  })

  it('описывает вложения', () => {
    expect(docs).toMatch(/attachmentIds/)
    expect(docs).toMatch(/Attaching files/)
  })
})
