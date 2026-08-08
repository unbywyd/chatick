import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Чат через мост.
//
// Главное здесь — видимость. В таблице сообщений лежит не только то, что
// команда прочитала: `held` — черновик, на который диспетчер задал автору
// уточняющий вопрос, `routed` превращено в действие и в чат не пошло,
// `pending` ещё не обработано. Живой интерфейс фильтрует их (canSee), и мост
// обязан фильтровать так же: он работает от имени человека и не должен видеть
// больше него. Проверка стоит здесь потому, что забыть это условие в новой
// выборке ничего не ломает — просто в ответе появляется лишнее.

const src = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')
const docs = readFileSync(join(import.meta.dirname, '../lib/bridge-docs.ts'), 'utf8')

function handler(method: string, path: string): string {
  const start = src.indexOf(`bridgeRoute.${method}('${path}'`)
  expect(start, `ручка ${method.toUpperCase()} ${path} не найдена`).toBeGreaterThan(-1)
  const rest = src.slice(start + 20)
  const end = rest.indexOf('bridgeRoute.')
  return rest.slice(0, end === -1 ? undefined : end)
}

describe('видимость сообщений', () => {
  it('правило совпадает с интерфейсом: доставленное либо своё', () => {
    const fn = src.slice(src.indexOf('function visibleInChat'), src.indexOf('function visibleInChat') + 400)
    expect(fn).toMatch(/eq\(messages\.status, 'delivered'/)
    expect(fn).toMatch(/eq\(messages\.authorId, userId\)/)
  })

  it('лента применяет фильтр', () => {
    expect(handler('get', '/messages')).toMatch(/visibleInChat\(id\.userId\)/)
  })

  it('окно вокруг сообщения применяет фильтр с обеих сторон', () => {
    const body = handler('get', '/messages/:id/context')
    expect(body.match(/visibleInChat\(id\.userId\)/g) ?? []).toHaveLength(2)
  })

  it('чужой черновик не открывается и по прямой ссылке', () => {
    expect(handler('get', '/messages/:id/context')).toMatch(
      /target\.status !== 'delivered' && target\.authorId !== id\.userId/,
    )
  })

  it('сырая история отдаёт только доставленное', () => {
    expect(handler('get', '/chat/messages')).toMatch(/eq\(messages\.status, 'delivered'/)
  })
})

describe('ветки', () => {
  it('лента показывает, кому отвечали', () => {
    expect(handler('get', '/messages')).toMatch(/replyTo:/)
  })

  it('окно вокруг сообщения показывает тоже', () => {
    expect(handler('get', '/messages/:id/context')).toMatch(/replyTo:/)
  })

  it('сырая история показывает тоже', () => {
    expect(handler('get', '/chat/messages')).toMatch(/replyTo:/)
  })
})

describe('POST /x/messages', () => {
  const body = handler('post', '/messages')

  it('не режет длинный текст молча — отказывает', () => {
    expect(body).toMatch(/text\.length > 20_000/)
    expect(body, 'обрезка через slice вернулась').not.toMatch(/text \|\| '📎'\)\.slice/)
  })

  it('уведомляет упомянутых', () => {
    expect(body).toMatch(/notifyChatMentions/)
  })

  it('ответ только на сообщение своего проекта', () => {
    expect(body).toMatch(/eq\(messages\.projectId, scope\.projectId\)/)
  })

  it('нельзя ответить на чужой неподтверждённый черновик', () => {
    expect(body).toMatch(/parent\.status !== 'delivered' && parent\.authorId !== id\.userId/)
  })
})

describe('поиск по чату', () => {
  const body = handler('get', '/chat/messages')

  it('слова достаточно без дат', () => {
    expect(body).toMatch(/!from && !to && !q\.q\?\.trim\(\)/)
  })

  it('поиск без периода отдаёт свежие совпадения, а не самые древние', () => {
    expect(body).toMatch(/const newestFirst = !from && !to/)
    expect(body).toMatch(/newestFirst \? desc\(messages\.createdAt\) : asc\(messages\.createdAt\)/)
    expect(body).toMatch(/if \(newestFirst\) items\.reverse\(\)/)
  })

  it('обрезка не молчит', () => {
    expect(body).toMatch(/hasMore/)
  })
})

describe('DELETE /x/messages/:id', () => {
  const body = handler('delete', '/messages/:id')

  it('своё удаляет автор, любое — админ', () => {
    expect(body).toMatch(/ownerOrAdmin\(scope\.projectId, id\.userId, msg\.authorId\)/)
    expect(body).toMatch(/403/)
  })

  it('не выходит за пределы проекта туннеля', () => {
    expect(body).toMatch(/eq\(messages\.projectId, scope\.projectId\)/)
  })

  it('трогает только общий чат', () => {
    // Личный диалог человека с ассистентом — не то, что мост вправе чистить
    // по чужой просьбе.
    expect(body).toMatch(/eq\(messages\.mode, 'group'\)/)
  })

  it('файлы остаются в проекте, а не удаляются вместе с репликой', () => {
    expect(body).toMatch(/set\(\{ messageId: null \}\)/)
  })

  it('чат узнаёт об удалении сразу', () => {
    // Без этого сообщение висит у всех открытых вкладок до перезагрузки.
    expect(body).toMatch(/broadcast\(scope\.projectId, 'message_deleted'/)
  })
})

describe('чего мосту не дают', () => {
  it('нет правки сообщений — её нет нигде в продукте', () => {
    // Не ограничение моста, а отсутствие возможности: у сообщения нет ни
    // правки в интерфейсе, ни отметки «изменено» в схеме. Появится в
    // продукте — этот тест и надо будет пересмотреть, осознанно.
    expect(src).not.toMatch(/bridgeRoute\.patch\('\/messages/)
  })
})

describe('гайд для ассистента', () => {
  it('объясняет, что видно не всё', () => {
    expect(docs).toMatch(/You see exactly what the human sees/)
  })

  it('объясняет ответ на сообщение', () => {
    expect(docs).toMatch(/replyTon?"? to answer a specific message|as "replyToId" to answer/)
  })

  it('называет предел длины и говорит, что текст не режется', () => {
    expect(docs).toMatch(/20000 characters/)
    expect(docs).toMatch(/rather than trimmed/)
  })

  it('описывает поиск по слову без дат', () => {
    expect(docs).toMatch(/pass q on its own/)
  })

  it('описывает удаление и правило', () => {
    expect(docs).toMatch(/DELETE \/x\/messages\/<id>/)
    expect(docs).toMatch(/the author removes their own, an admin\s+removes any/)
  })

  it('оба гайда знают про удаление — и проектный, и компанейский', () => {
    // Ровно та ошибка, о которой предупреждает шапка bridge-docs: гайдов два,
    // и фича, описанная в одном, для половины подключений молча не
    // существует. Так уже было с чек-листом.
    const docCount = (docs.match(/DELETE \/x\/messages/g) ?? []).length
    expect(docCount, 'удаление сообщений описано только в одном из двух гайдов').toBeGreaterThanOrEqual(2)
    // И оба предупреждают о необратимости, а не только один.
    expect((docs.match(/permanent|no trash/gi) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('предупреждает, что удаление необратимо и видно всем', () => {
    expect(docs).toMatch(/This is permanent and it disappears for everyone/)
  })

  it('говорит, что своё сообщение ассистента снимает только админ', () => {
    // У реплики ИИ автора нет, и без этой оговорки ассистент будет считать
    // её «своей» и не поймёт отказа.
    expect(docs).toMatch(/assistant itself has no author/)
  })

  it('говорит, что правки нет ни у кого — чтобы не искал ручку', () => {
    expect(docs).toMatch(/Editing a message is not possible for anyone/)
  })
})
