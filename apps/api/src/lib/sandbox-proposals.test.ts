import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseProposedTasks } from './dispatcher.js'

// Предложение задач в sandbox.
//
// Ассистент замечает, что реплика — это поручение, и предлагает завести её в
// трекер. Здесь легко получить две тихие поломки:
//
//   1. кривой JSON от модели рушит весь ответ — человек теряет и разговор, и
//      объяснение, ради которого сообщение придержали;
//   2. создаёт модель, а не сервер — тогда заводится то, как она поняла
//      разговор, а не то, что человек отметил галочками в карточке.
//
// Первое проверяется вызовом, второе — по исходнику ручки.

const route = readFileSync(join(import.meta.dirname, '../routes/messages.ts'), 'utf8')
const disp = readFileSync(join(import.meta.dirname, 'dispatcher.ts'), 'utf8')

describe('разбор предложенных задач', () => {
  it('читает обычный массив', () => {
    const out = parseProposedTasks('[{"title":"Проверить функцию","assignee":"Артём","estimateMinutes":60}]')
    expect(out).toEqual([{ title: 'Проверить функцию', description: undefined, assignee: 'Артём', estimateMinutes: 60 }])
  })

  it('снимает ```json-обёртку, которую любят модели', () => {
    expect(parseProposedTasks('```json\n[{"title":"A"}]\n```')).toHaveLength(1)
  })

  it('кривой JSON не роняет ответ — просто нет карточки', () => {
    expect(parseProposedTasks('[{"title": "оборвал')).toEqual([])
    expect(parseProposedTasks('не json вовсе')).toEqual([])
    expect(parseProposedTasks(null)).toEqual([])
  })

  it('выбрасывает записи без заголовка: пустая строка в карточке нечитаема', () => {
    expect(parseProposedTasks('[{"title":""},{"title":"  "},{"title":"Настоящая"}]')).toEqual([
      { title: 'Настоящая', description: undefined, assignee: undefined, estimateMinutes: undefined },
    ])
  })

  it('отсекает измельчение: больше семи задач в карточке не читают', () => {
    const many = JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ title: `T${i}` })))
    expect(parseProposedTasks(many)).toHaveLength(7)
  })

  it('игнорирует мусорную оценку вместо того, чтобы писать её в задачу', () => {
    const [t] = parseProposedTasks('[{"title":"A","estimateMinutes":-5},{"title":"B","estimateMinutes":"час"}]')
    expect(t?.estimateMinutes).toBeUndefined()
  })
})

describe('карточку исполняет сервер, а не модель', () => {
  const apply = route.slice(route.indexOf("'/:messageId/sandbox/:itemId/apply'"))

  it('создаёт задачи тем же кодом, что и ассистент', () => {
    // своя копия создания разошлась бы с create_tasks при первой же правке
    expect(apply).toMatch(/handlers\.create_tasks/)
  })

  it('заводит только отмеченные человеком строки', () => {
    expect(apply).toMatch(/indexes/)
  })

  it('не срабатывает дважды: sandbox остаётся открытым после нажатия', () => {
    expect(apply).toMatch(/appliedAt/)
    expect(apply).toMatch(/409/)
  })
})

describe('перехват поручения', () => {
  it('диспетчер помечает поручение флагом work', () => {
    expect(disp).toMatch(/"work"/)
  })

  it('флаг переживает обрыв ответа по лимиту токенов', () => {
    // work стоит в JSON последним и теряется первым — без этого поручение
    // открывает sandbox без карточки, ради которой его и придержали
    expect(disp).toMatch(/"work"\\s\*:\\s\*true/)
  })

  it('карточка предлагается сразу при hold, а не после реплики автора', () => {
    const held = route.slice(route.indexOf("set({ status: 'held' })"))
    expect(held.slice(0, 2000)).toMatch(/verdict\.work/)
    expect(held.slice(0, 2000)).toMatch(/kind: 'tasks'/)
  })

  it('лишнего вызова модели на каждый придержанный пустяк нет', () => {
    const held = route.slice(route.indexOf("set({ status: 'held' })"), route.indexOf("sendToUser(projectId, sub, 'held'"))
    expect(held).toMatch(/if \(verdict\.work\)/)
  })
})
