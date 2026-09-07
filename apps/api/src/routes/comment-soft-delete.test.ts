import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Мягкое удаление комментариев.
 *
 * Раньше удаление было физическим и не писалось в журнал: комментарий пропадал
 * бесследно, а уведомление о нём оставалось и вело в задачу, где ничего нет.
 * Живой случай (Whatidog, TASK-6): человек удалил комментарий и написал тот же
 * текст в соседнюю задачу — в инбоксе осталась ссылка в пустоту, и доказать,
 * что комментарий был, оказалось нечем.
 */

const api = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8').replace(/\r\n/g, '\n')
const app = (p: string) =>
  readFileSync(join(import.meta.dirname, '../../../app/src/', p), 'utf8').replace(/\r\n/g, '\n')

const tasks = api('routes/tasks.ts')
const bridge = api('routes/bridge.ts')
const memory = api('lib/memory.ts')
const schema = api('db/schema.ts')
const client = app('components/tabs/tasks/TaskComments.tsx')

const handler = tasks.slice(
  tasks.indexOf("tasksRoute.delete('/:taskId/comments/:commentId'"),
  tasks.indexOf("tasksRoute.post('/validate'"),
)

describe('удаление не стирает строку', () => {
  it('обработчик обновляет, а не удаляет', () => {
    // Саботаж: вернуть db.delete(taskComments) — тест падает.
    expect(handler, 'обработчик удаления исчез').toBeTruthy()
    expect(handler, 'комментарий удаляется физически').not.toMatch(/db\s*\.delete\(taskComments\)/)
    expect(handler, 'нет мягкого удаления').toMatch(/deletedAt: new Date\(\), deletedById: sub/)
  })

  it('колонки есть в схеме', () => {
    const t = schema.slice(schema.indexOf('export const taskComments'), schema.indexOf('export const taskComments') + 1400)
    expect(t, 'нет deletedAt').toMatch(/deletedAt: timestamp\('deleted_at'/)
    expect(t, 'нет deletedById').toMatch(/deletedById: text\('deleted_by_id'\)/)
  })

  it('повторное удаление не переписывает, кто удалил', () => {
    // Кто и когда удалил, важнее последнего нажатия кнопки.
    // Саботаж: убрать проверку — тест падает.
    expect(handler, 'повторное удаление перезаписывает автора').toMatch(/if \(comment\.deletedAt\) return/)
  })

  it('удаление пишется в историю задачи', () => {
    // Раньше комментарий исчезал без следа: ни строки, ни записи.
    // Саботаж: убрать logActivity — тест падает.
    expect(handler, 'удаление не логируется').toMatch(/logActivity\(\{[\s\S]{0,200}action: 'delete'/)
    expect(handler, 'логируется не комментарий').toMatch(/entityType: 'comment'/)
    // С куском текста: «удалил комментарий» без содержимого не говорит, о чём речь.
    expect(handler, 'в журнале нет содержимого').toMatch(/entityLabel: comment\.body/)
  })

  it('уведомления о нём гасятся', () => {
    // Уведомление ведёт в никуда — оно и отправило человека искать
    // несуществующий комментарий.
    //
    // Саботаж: убрать dropNotice — тест падает.
    expect(handler, 'уведомления не гасятся').toMatch(/dropNotice\(\{ userId/)
    // Ключ ТОТ ЖЕ, что при отправке, иначе гасить нечего.
    expect(handler, 'ключ дедупа не совпадает с отправкой').toMatch(/task_comment:\$\{commentId\}/)
  })
})

describe('удалённые не попадают туда, где их быть не должно', () => {
  it('мост и ассистент их не читают', () => {
    // Их убрали намеренно — строить на них выводы нельзя.
    // Саботаж: убрать isNull(taskComments.deletedAt) — тест падает.
    const reads = [
      ['мост: комментарии задачи', bridge],
      ['ассистент в интерфейсе', memory],
    ] as const
    for (const [name, text] of reads) {
      expect(text, `${name}: удалённые не отфильтрованы`).toMatch(/isNull\(taskComments\.deletedAt\)/)
    }
  })

  it('веб-лента показывает плашку, но НЕ тело', () => {
    // Плашка держит место в разговоре: ответы на удалённый комментарий иначе
    // повисли бы без начала. Но содержимое отдавать нельзя — удалили именно его.
    //
    // Саботаж: отдавать body всегда — тест падает.
    const list = tasks.slice(tasks.indexOf("tasksRoute.get('/:taskId/comments'"), tasks.indexOf("tasksRoute.post(\n  '/:taskId/comments'"))
    expect(list, 'тело удалённого отдаётся').toMatch(/body: deleted \? '' : r\.comment\.body/)
    expect(list, 'клиент не узнает про удаление').toMatch(/deleted,/)
    // Вложения тоже: они были частью удалённого сообщения.
    expect(list, 'вложения удалённого отдаются').toMatch(/files: deleted \? \[\]/)
  })

  it('клиент рисует плашку и прячет действия', () => {
    // Править и отвечать нечему.
    // Саботаж: убрать !c.deleted у кнопок — тест падает.
    expect(client, 'плашки нет').toMatch(/tasks\.commentDeleted/)
    // ОБЕ кнопки: правки и удаления. Одна оставшаяся — уже дыра.
    const guarded = (client.match(/mine && !c\.deleted/g) ?? []).length
    expect(guarded, 'не все действия скрыты у удалённого').toBe(2)
    // И ответить на удалённый нельзя: отвечать не на что.
    expect(client, 'на удалённый можно ответить').toContain('{!c.deleted && (')
  })
})

describe('переводы плашки есть во всех языках', () => {
  for (const loc of ['ru', 'en', 'he'] as const) {
    it(loc, () => {
      const j = JSON.parse(
        readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${loc}.json`), 'utf8'),
      )
      expect(j.tasks?.commentDeleted, `нет tasks.commentDeleted в ${loc}`).toBeTruthy()
    })
  }
})
