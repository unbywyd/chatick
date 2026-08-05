import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Управление временем через мост.
//
// Главная ловушка — «текущий проект». Часы принадлежат ЧЕЛОВЕКУ: он один, и
// уйдя в другой проект, работать не перестаёт. Стоит добавить в выборку
// projectId — и лимит параллельных таймеров обходится (по таймеру в каждом
// проекте), забытый в соседнем проекте таймер становится невидимым, а
// остановить его нельзя: ассистент отвечает «таймер не запущен», пока часы
// идут. Ничего при этом не падает, поэтому проверка стоит здесь.

const src = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')
const docs = readFileSync(join(import.meta.dirname, '../lib/bridge-docs.ts'), 'utf8')

function handler(method: string, path: string): string {
  const start = src.indexOf(`bridgeRoute.${method}('${path}'`)
  expect(start, `ручка ${method.toUpperCase()} ${path} не найдена`).toBeGreaterThan(-1)
  const rest = src.slice(start + 20)
  const end = rest.indexOf('bridgeRoute.')
  return rest.slice(0, end === -1 ? undefined : end)
}

/** Выборка идущих таймеров не должна ограничиваться проектом. */
function noProjectFilterOnRunning(body: string) {
  const sel = body.slice(body.indexOf('isNull(timeEntries.endedAt)') - 400, body.indexOf('isNull(timeEntries.endedAt)') + 40)
  expect(sel, 'выборка идущих таймеров снова ограничена проектом').not.toMatch(/eq\(timeEntries\.projectId/)
  expect(sel).toMatch(/eq\(timeEntries\.userId, id\.userId\)/)
}

describe('таймеры считаются по человеку, а не по проекту', () => {
  it('список идущих охватывает все проекты', () => {
    noProjectFilterOnRunning(handler('get', '/time/running'))
  })

  it('и помечает, какой из них здесь', () => {
    expect(handler('get', '/time/running')).toMatch(/here: r\.e\.projectId === scope\.projectId/)
  })

  it('лимит при старте считает все проекты', () => {
    noProjectFilterOnRunning(handler('post', '/time/start'))
  })

  it('и называет проект, где таймер уже идёт', () => {
    expect(handler('post', '/time/start')).toMatch(/elsewhere\.p\?\.name/)
  })

  it('остановка находит таймер в любом проекте', () => {
    noProjectFilterOnRunning(handler('post', '/time/stop'))
  })

  it('остановка оповещает проект таймера, а не тот, откуда пришёл запрос', () => {
    expect(handler('post', '/time/stop')).toMatch(/broadcast\(entry\.projectId, 'time'/)
  })
})

describe('трей узнаёт о таймере', () => {
  it('старт', () => {
    expect(handler('post', '/time/start')).toMatch(/sendToUserAnywhere\(id\.userId, 'time'/)
  })
  it('остановка', () => {
    expect(handler('post', '/time/stop')).toMatch(/sendToUserAnywhere\(id\.userId, 'time'/)
  })
  it('запись задним числом', () => {
    expect(handler('post', '/time')).toMatch(/sendToUserAnywhere\(id\.userId, 'time'/)
  })
})

describe('пауза и продолжение', () => {
  const body = handler('post', '/time/resume')

  it('переносит описание и задачу — иначе они теряются', () => {
    expect(body).toMatch(/description: source\.description/)
    expect(body).toMatch(/taskId: source\.taskId/)
  })

  it('по умолчанию продолжает последнее законченное', () => {
    expect(body).toMatch(/is not null/)
    expect(body).toMatch(/orderBy: desc\(timeEntries\.endedAt\)/)
  })

  it('чужую запись не продолжает', () => {
    expect(body).toMatch(/eq\(timeEntries\.userId, id\.userId\)/)
  })

  it('уважает лимит параллельных таймеров', () => {
    expect(body).toMatch(/running\.length >= cfg\.maxTimers/)
  })
})

describe('правка записи', () => {
  const body = handler('patch', '/time/:id')

  it('чужую правит только руководство проекта', () => {
    expect(body).toMatch(/entry\.userId !== id\.userId && !\(await hasPermission\(scope\.projectId, id\.userId, 'tasks\.edit'\)\)/)
  })

  it('и только запись этого проекта', () => {
    expect(body).toMatch(/eq\(timeEntries\.projectId, scope\.projectId\)/)
  })

  it('переносит в другой проект только к тем, где человек состоит', () => {
    expect(body).toMatch(/projectRoleOf\(b\.project, id\.userId\)/)
  })

  it('при переносе рвёт связь с задачей прежнего проекта', () => {
    expect(body).toMatch(/patch\.taskId = null/)
  })

  it('не пускает конец раньше начала', () => {
    expect(body).toMatch(/endedAt must be later than startedAt/)
  })
})

describe('даты разбираются, а не падают', () => {
  it('есть общий разбор отметки времени', () => {
    expect(src).toMatch(/function parseStamp/)
  })

  it('старт проверяет startedAt', () => {
    const body = handler('post', '/time/start')
    expect(body).toMatch(/parseStamp\(b\.startedAt\)/)
    expect(body).toMatch(/startedAt is in the future/)
  })
})

describe('чего мосту не дают', () => {
  it('нет удаления записей времени', () => {
    expect(src).not.toMatch(/bridgeRoute\.delete\('\/time/)
  })
})

describe('гайд для ассистента', () => {
  it('объясняет, что паузы нет и почему', () => {
    expect(docs).toMatch(/Pausing IS stopping/)
  })

  it('описывает продолжение', () => {
    expect(docs).toMatch(/x\/time\/resume/)
  })

  it('говорит, что лимит про человека', () => {
    expect(docs).toMatch(/limit counts the PERSON/)
  })

  it('описывает правку и перенос в другой проект', () => {
    expect(docs).toMatch(/PATCH \/x\/time/)
    expect(docs).toMatch(/move the hours/)
  })

  it('говорит, что удалять нельзя', () => {
    expect(docs).toMatch(/Deleting entries is not available/)
  })
})
