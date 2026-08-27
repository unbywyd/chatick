import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { richText } from '../lib/markdown.js'

// Ответ под пунктом чек-листа.
//
// Пишут его двумя путями: человек в приложении (разметка редактора) и ассистент
// через мост (markdown). Пока разбор стоял только на одном, ответы хранились
// в двух разных видах, и один из них показывался звёздочками наружу.
//
// Читает мост его тоже — но моделью, поэтому наружу отдаём текст: теги в ответе
// она примет за часть ответа.

const tasks = readFileSync(join(import.meta.dirname, 'tasks.ts'), 'utf8')
const bridge = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')

describe('оба пути записи приводят ответ к одному виду', () => {
  it('приложение: и создание, и правка через richText', () => {
    expect(tasks).toMatch(/note: note \? richText\(note\) : ''/)
    expect(tasks).toMatch(/patch\.note = richText\(b\.note\)/)
  })

  it('мост: и создание, и правка через richText', () => {
    expect(bridge).toMatch(/note: typeof x\.note === 'string' \? richText\(/)
    expect(bridge).toMatch(/patch\.note = richText\(b\.note\.slice/)
  })

  it('мост отдаёт ответ текстом, а не разметкой', () => {
    expect(bridge).toMatch(/note: \(r\.item\.note && htmlToText\(r\.item\.note\)\) \|\| undefined/)
  })
})

describe('что получается из типичного ответа ассистента', () => {
  it('markdown становится разметкой, а не остаётся звёздочками', () => {
    const html = richText('**Да**, ключом из App Store Connect')
    expect(html).toContain('<strong>Да</strong>')
    expect(html).not.toContain('**')
  })

  it('ивритский ответ разворачивается вправо', () => {
    expect(richText('כן, צריך מפתח p8')).toContain('dir="rtl"')
  })

  it('пустой ответ остаётся пустым, а не превращается в пустой абзац', () => {
    // Иначе «стёр и ушёл» оставлял бы заметку, которая выглядит пустой, но
    // занимает место в списке и не даёт кнопке «ответить» вернуться под пункт.
    expect(richText('')).toBe('')
    expect(richText('   ')).toBe('')
  })
})

// Кто что может в чек-листе.
//
// Спрашивает один, а знает ответ обычно другой: требовать от него права
// править задачу — значит закрыть единственный путь, ради которого пункт и
// заведён. Но состав списка — другое дело: с одним доступом на чтение
// переписывать содержание задачи нельзя.
describe('права', () => {
  const patchItem = tasks.slice(tasks.indexOf("  '/:taskId/checklist/:itemId',"), tasks.indexOf("tasksRoute.delete('/:taskId/checklist/:itemId'"))
  const order = tasks.slice(tasks.indexOf("  '/:taskId/checklist/order',"), tasks.indexOf("  '/:taskId/checklist/:itemId',"))

  it('видеть задачу достаточно, чтобы дойти до пункта', () => {
    expect(tasks).toMatch(/hasPermission\(projectId, userId, 'tasks\.read'\)/)
  })

  it('отметить и ответить — без tasks.edit', () => {
    // Права проверяются только для text/sortOrder; общей проверки на весь
    // обработчик быть не должно.
    expect(patchItem).toMatch(/b\.text !== undefined \|\| b\.sortOrder !== undefined/)
    expect((patchItem.match(/tasks\.edit/g) ?? []).length).toBe(1)
  })

  it('переписать формулировку — только с tasks.edit', () => {
    expect(patchItem).toMatch(/b\.sortOrder !== undefined\) && !\(await hasPermission\(projectId, sub, 'tasks\.edit'\)\)/)
  })

  it('порядок меняет тот, кто правит задачу', () => {
    expect(order).toMatch(/tasks\.edit/)
  })

  it('перестановка не уносит чужие пункты', () => {
    // Без проверки принадлежности чужой id в списке получил бы номер и уехал
    // в чей-то другой чек-лист.
    expect(order).toMatch(/mine\.has\(itemId\)/)
  })

  it('удалить пункт — только с tasks.edit', () => {
    const del = tasks.slice(tasks.indexOf("tasksRoute.delete('/:taskId/checklist/:itemId'"))
    expect(del.slice(0, 900)).toMatch(/tasks\.edit/)
  })

  it('ручка порядка объявлена ДО ручки пункта — иначе «order» примут за id', () => {
    expect(tasks.indexOf("'/:taskId/checklist/order'")).toBeLessThan(tasks.indexOf("'/:taskId/checklist/:itemId'"))
  })
})

describe('на ответ под пунктом теперь приходит уведомление', () => {
  // Раньше не приходило никому. У checklistAccess это было записано доводом:
  // «человек и так смотрит на свою задачу». Верно, пока задачу ведёт человек;
  // задачу, заведённую ассистентом, не смотрит никто, и ответ оставался в
  // пункте навсегда. Отвечавшему приходилось писать отдельный комментарий
  // «я ответил в пунктах» — когда человек дублирует уведомление руками,
  // механизма нет.

  it('ОБА пути записи уведомляют, а не один', () => {
    // Главный путь — веб: им отвечает человек. Уведомление только в мосту
    // покрыло бы ассистента и пропустило того, ради кого всё делалось.
    expect(tasks, 'веб-путь молчит').toMatch(/void checklistAnswerNotice\(\{/)
    expect(bridge, 'мост молчит').toMatch(/void checklistAnswerNotice\(\{/)
  })

  it('только когда заметка непуста И изменилась', () => {
    // updatedAt здесь ставится безусловно, поэтому снятие галочки или
    // повторное сохранение того же текста иначе дёргали бы людей ни за чем.
    for (const [src, name] of [
      [tasks, 'веб'],
      [bridge, 'мост'],
    ] as const) {
      expect(src, `${name}: нет проверки на изменение`).toMatch(
        /patch\.note && patch\.note !== existing\.note/,
      )
    }
  })

  it('одна запись на задачу: dropNotice ДО notify', () => {
    // При занятом ключе notify молча пропускает повтор, и человек навсегда
    // остался бы с текстом ПЕРВОГО ответа.
    const fn = tasks.slice(tasks.indexOf('export async function checklistAnswerNotice'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    const drop = body.indexOf('dropNotice')
    const notif = body.indexOf('await notify(')
    expect(drop, 'dropNotice не зовётся').toBeGreaterThan(-1)
    expect(notif, 'notify не зовётся').toBeGreaterThan(-1)
    expect(drop, 'dropNotice должен идти ДО notify').toBeLessThan(notif)
  })

  it('ключ дедупа — на задачу и БЕЗ userId', () => {
    // notify и dropNotice доклеивают `:${user.id}` сами. С userId в базовом
    // ключе вышло бы `...:user:user`, и dropNotice не нашёл бы ничего — молча.
    const fn = tasks.slice(tasks.indexOf('export async function checklistAnswerNotice'))
    expect(fn.slice(0, 2500)).toMatch(/dedupeKey = `checklist_answer:\$\{task\.id\}`/)
  })

  it('получатели — автор и исполнитель, себе не шлём', () => {
    const notify = readFileSync(join(import.meta.dirname, '../lib/notify.ts'), 'utf8')
    const fn = notify.slice(notify.indexOf('export function checklistAnswerWatchers'))
    expect(fn.slice(0, 700)).toMatch(/\[assigneeId, createdById\]/)
    expect(fn.slice(0, 700)).toMatch(/x !== actorId/)
  })

  it('создание пункта сразу с ответом не уведомляет', () => {
    // Класть пункт может только тот, кто правит задачу, — он же и адресат:
    // вышло бы «сам себе положил вопрос и получил уведомление о нём».
    const post = tasks.slice(tasks.indexOf("tasksRoute.post('/:taskId/checklist'"))
    expect(post.slice(0, 1400)).not.toMatch(/checklistAnswerNotice/)
  })

  it('событие своё, а не task_comment', () => {
    // Инбокс группирует по событию: слепив ответы с комментариями, мы не
    // отделили бы «на мой вопрос ответили» от «кто-то что-то написал».
    // И заголовок «прокомментировал TASK-81» был бы неправдой.
    const schema = readFileSync(join(import.meta.dirname, '../db/schema.ts'), 'utf8')
    expect(schema).toMatch(/'checklist_answer'/)
    const notify = readFileSync(join(import.meta.dirname, '../lib/notify.ts'), 'utf8')
    for (const lang of ['en', 'ru', 'he']) {
      const block = notify.slice(notify.indexOf(`  ${lang}: {`))
      expect(block.slice(0, 1400), `нет перевода для ${lang}`).toMatch(/checklist_answer:/)
    }
  })
})
