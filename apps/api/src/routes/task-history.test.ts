import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * История задачи — путь, а не журнал всех прикосновений.
 *
 * Записи в activity_log были всегда: 2019 штук по задачам, включая статусы и
 * назначения. Не было только места, где человек их увидит.
 *
 * Но показать всё подряд нельзя. Перетаскивание задачи в списке пишет запись
 * НА КАЖДОЕ движение мыши: у TASK-1 девять «изменил» подряд за две минуты, все
 * с meta {"changed":["sortOrder"]}. Плюс правки описания. Настоящие шаги —
 * завели, назначили, перевели в работу, сдали — потонули бы в этом.
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8')
const tasks = read('tasks.ts')
const ui = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/tabs/tasks/TaskHistory.tsx'),
  'utf8',
)

describe('лента показывает вехи, а не всякое касание', () => {
  const at = tasks.indexOf("tasksRoute.get('/:taskId/history'")
  const fn = tasks.slice(at, tasks.indexOf("tasksRoute.get('/:taskId/checklist'"))

  it('ручка есть', () => {
    expect(at, 'ручка истории задачи не найдена').toBeGreaterThan(-1)
  })

  it('перетаскивание в списке отсеивается', () => {
    // Саботаж: убрать фильтр — и лента TASK-1 начнётся с девяти одинаковых
    // строк «изменил задачу», за которыми не видно ничего.
    expect(fn.replace(/\s+/g, ' '), 'фильтр вех потерян').toContain(
      "return changed.some((f) => ['status', 'assigneeId', 'dueDate', 'priority', 'groupId', 'estimateMinutes'].includes(f))",
    )
    expect(fn, 'фильтр не применён к выдаче').toMatch(/\.filter\(\(x\) => isMilestone\(x\.action, x\.meta\)\)/)
    // sortOrder в список вех попасть не должен — ради него всё и затевалось.
    const list = fn.slice(fn.indexOf('isMilestone'), fn.indexOf('const items'))
    expect(list, 'sortOrder снова считается вехой').not.toMatch(/'sortOrder'/)
  })

  it('создание и удаление проходят всегда, без разбора полей', () => {
    // У create нет meta вовсе: проверка по changed выбросила бы самый первый
    // шаг — «кто завёл задачу».
    expect(fn.replace(/\s+/g, ' ')).toContain("if (action !== 'update') return true")
  })

  it('доступ тот же, что к самой задаче', () => {
    // Иначе историю чужого проекта можно прочитать по прямой ссылке.
    expect(fn).toMatch(/checklistAccess\(projectId, c\.req\.param\('taskId'\), sub\)/)
    expect(fn).toMatch(/if \('error' in access\) return c\.json/)
  })

  it('отбор идёт по ЭТОЙ задаче, а не по всему проекту', () => {
    expect(fn.replace(/\s+/g, ' ')).toContain('eq(activityLog.entityId, access.task.id)')
    expect(fn.replace(/\s+/g, ' ')).toContain("eq(activityLog.entityType, 'task')")
  })

  it('порядок — от старого к новому: это путь, а не лента новостей', () => {
    expect(fn).toMatch(/\.orderBy\(asc\(activityLog\.createdAt\)\)/)
  })
})

describe('журнал запоминает значения, а не только имена полей', () => {
  it('статус пишется вместе с тем, на что его сменили', () => {
    // Раньше ложилось {"changed":["status"]} — «сменил статус», и ни слова о
    // том, на какой. Оба значения лежат прямо в месте записи: task это до,
    // row это после.
    const at = tasks.indexOf('const act = body.status !== undefined')
    const fn = tasks.slice(at, at + 2200)
    expect(fn.replace(/\s+/g, ' ')).toContain('before.status = task.status')
    expect(fn.replace(/\s+/g, ' ')).toContain('after.status = row!.status')
  })

  it('исполнитель, срок и важность — тоже со значениями', () => {
    const at = tasks.indexOf('const act = body.status !== undefined')
    const fn = tasks.slice(at, at + 2200).replace(/\s+/g, ' ')
    for (const field of ['assigneeId', 'priority', 'dueDate']) {
      expect(fn, `${field} пишется без значения`).toContain(`after.${field} = row!.${field}`)
    }
  })

  it('текст описания в журнал НЕ кладём', () => {
    // Описание бывает в тысячи знаков, а журнал не хранилище версий.
    const at = tasks.indexOf('const act = body.status !== undefined')
    const fn = tasks.slice(at, at + 2200)
    expect(fn, 'описание попало в журнал').not.toMatch(/after\.description|before\.description/)
  })

  it('пустой before/after не пишется вовсе', () => {
    // Правка одного лишь порядка не должна раздувать запись пустыми объектами.
    const at = tasks.indexOf('const act = body.status !== undefined')
    expect(tasks.slice(at, at + 2200).replace(/\s+/g, ' ')).toContain(
      '...(Object.keys(after).length ? { before, after } : {})',
    )
  })
})

describe('интерфейс', () => {
  it('свёрнуто по умолчанию и не грузит данные до открытия', () => {
    // У задачи и без того несколько запросов при открытии, а историю
    // смотрят изредка.
    expect(ui).toMatch(/const \[open, setOpen\] = useState\(false\)/)
    expect(ui).toMatch(/enabled: open/)
  })

  it('старая запись без значений не выдумывает их', () => {
    // 2019 записей до этой правки несут только имя поля. Врать о том, чего
    // не записано, нельзя — говорим «сменил статус», без «на какой».
    expect(ui).toMatch(/statusChanged/)
    expect(ui).toMatch(/typeof to === 'string'\s*\?\s*t\('taskHistory\.statusTo'/)
  })

  it('снятие исполнителя отличается от старой записи', () => {
    // null значит «сняли», undefined — «значения не записаны». Разные строки.
    expect(ui).toMatch(/if \(to === null\) return t\('taskHistory\.unassigned'\)/)
  })

  it('действие ИИ не выдаётся за человеческое', () => {
    expect(ui).toMatch(/taskHistory\.system/)
  })
})

describe('перевод на три языка', () => {
  for (const lang of ['ru', 'en', 'he']) {
    it(`${lang}: строки истории переведены`, () => {
      const json = JSON.parse(
        readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${lang}.json`), 'utf8'),
      ) as { taskHistory: Record<string, string> }
      for (const key of ['title', 'created', 'statusTo', 'assignedTo', 'system', 'empty']) {
        expect(json.taskHistory?.[key], `${lang}.taskHistory.${key} отсутствует`).toBeTruthy()
      }
    })
  }
})
