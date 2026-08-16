import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_NOTIFY_CONFIG, readNotifyConfig, setDue } from './notify-config.js'

// Уведомления о сроке задачи и настройки на уровне компании (SPEC §8.9).
//
// Две вещи, которые ломаются молча и потому проверяются здесь:
//
//  1. настройка компании должна ДОХОДИТЬ до проекта — иначе правило «за сутки»
//     заводят один раз, а работает оно нигде;
//  2. смена срока должна снимать метку «уже предупредили» — иначе задача
//     теряет напоминание навсегда, и по коду это не видно.

const here = import.meta.dirname
const read = (p: string) => readFileSync(join(here, p), 'utf8')

describe('чтение настроек', () => {
  it('пустая строка — это умолчания, а не «всё выключено»', () => {
    // '{}' стоит у всех проектов с рождения. Принять его за осознанный выбор
    // значило бы выключить людям уведомления, которых они не выключали.
    expect(readNotifyConfig('')).toEqual(DEFAULT_NOTIFY_CONFIG)
    expect(readNotifyConfig('{}')).toEqual(DEFAULT_NOTIFY_CONFIG)
    expect(readNotifyConfig(null)).toEqual(DEFAULT_NOTIFY_CONFIG)
  })

  it('битый JSON не роняет отправку', () => {
    expect(readNotifyConfig('{не json')).toEqual(DEFAULT_NOTIFY_CONFIG)
  })

  it('выключает только явный false', () => {
    // Отсутствие ключа — «не трогали». Иначе событие, добавленное позже,
    // оказалось бы выключенным у всех, кто сохранял настройки до него.
    const cfg = readNotifyConfig(JSON.stringify({ events: { chat_mention: false } }))
    expect(cfg.events.chat_mention).toBe(false)
    expect(cfg.events.task_due).toBe(true)
    expect(cfg.events.task_assigned).toBe(true)
  })

  it('упреждение держится в разумных границах', () => {
    // Час — нижняя граница: предупреждать за минуту бессмысленно. Две недели —
    // верхняя: дальше это уже не напоминание, а прогноз.
    expect(readNotifyConfig(JSON.stringify({ dueLeadHours: 0 })).dueLeadHours).toBe(24)
    expect(readNotifyConfig(JSON.stringify({ dueLeadHours: -5 })).dueLeadHours).toBe(24)
    expect(readNotifyConfig(JSON.stringify({ dueLeadHours: 99999 })).dueLeadHours).toBe(24 * 14)
    expect(readNotifyConfig(JSON.stringify({ dueLeadHours: 48 })).dueLeadHours).toBe(48)
  })

  it('умолчание — сутки', () => {
    // За час рабочий день уже расписан, за неделю забудут.
    expect(DEFAULT_NOTIFY_CONFIG.dueLeadHours).toBe(24)
  })
})

describe('смена срока снимает метку «предупредили»', () => {
  it('setDue всегда обнуляет dueNotifiedAt', () => {
    const patch: { dueDate?: Date | null; dueNotifiedAt?: Date | null } = {}
    setDue(patch, new Date('2026-09-14T12:00:00Z'))
    expect(patch.dueDate?.toISOString()).toBe('2026-09-14T12:00:00.000Z')
    expect(patch.dueNotifiedAt).toBeNull()
  })

  it('и при снятии срока тоже', () => {
    // Дату могут вернуть — тогда предупредить надо заново.
    const patch: { dueDate?: Date | null; dueNotifiedAt?: Date | null } = {}
    setDue(patch, null)
    expect(patch.dueDate).toBeNull()
    expect(patch.dueNotifiedAt).toBeNull()
  })

  it('ни один путь записи срока не пишет dueDate мимо setDue', () => {
    // Путей четыре: REST, мост поштучно, мост пакетом, ассистент. Забыть
    // сбросить метку на одном из них — значит молча лишить задачу
    // напоминания, и тесты выше этого не заметят.
    const sources = [
      read('../routes/tasks.ts'),
      read('../routes/bridge.ts'),
      read('./memory.ts'),
    ]
    for (const src of sources) {
      // Разрешено только чтение (t.dueDate), объявление поля при создании
      // (dueDate: …) и запись через setDue. Присваивание patch.dueDate = —
      // ровно то, что мы запрещаем.
      expect(src).not.toMatch(/patch\.dueDate\s*=/)
    }
  })
})

describe('проект наследует настройки компании', () => {
  const src = read('./notify-config.ts')

  it('своё важнее, но пустое своё — не выбор', () => {
    // Тот же приём, что и у time_config: «{}» отправляет читателя к компании.
    expect(src).toMatch(/own && own !== '\{\}' \? own : r\.company/)
  })

  it('настройка компании читается через join, а не отдельным запросом', () => {
    expect(src).toMatch(/leftJoin\(companies/)
  })
})

describe('уведомление о сроке', () => {
  const notify = read('./notify.ts')
  const reminders = read('./reminders.ts')

  it('проектная настройка проверяется до личных отписок', () => {
    // Канал закрыт руководством — разбирать индивидуальные предпочтения
    // незачем, и лишний запрос в базу тоже не нужен.
    const gate = notify.indexOf('notifyConfigForProject')
    const optouts = notify.indexOf('notificationOptOuts.findMany')
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(optouts)
  })

  it('сделанные задачи не напоминают о себе', () => {
    expect(reminders).toMatch(/inArray\(tasks\.status, \['todo', 'in_progress', 'review'\]\)/)
  })

  it('метка ставится даже когда некому слать', () => {
    // Иначе задача без исполнителя и автора всплывает в каждом тике до
    // самого удаления — раз в пять минут, вечно.
    const fn = reminders.slice(reminders.indexOf('async function sweepDueTasks'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    // update идёт ПОСЛЕ закрывающей скобки if (recipients.length) — то есть
    // выполняется в обеих ветках.
    expect(body).toMatch(/if \(recipients\.length\) \{[\s\S]*\}\s*await db\.update\(tasks\)\.set\(\{ dueNotifiedAt/)
  })

  it('срок приходит получателю на его языке', () => {
    // В vars уезжает ISO, а слова подбирает notify — он один знает locale
    // получателя. Иначе иврит получил бы «tomorrow».
    expect(reminders).toMatch(/dueAt: t\.dueDate!\.toISOString\(\)/)
    expect(notify).toMatch(/vars\.when = dueWords\(vars\.dueAt, lang\)/)
  })

  it('у события нет актора', () => {
    // Срок наступает сам. Подставить сюда автора задачи значило бы написать,
    // будто это он что-то сделал.
    const fn = reminders.slice(reminders.indexOf('async function sweepDueTasks'))
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toMatch(/actorId: null/)
    for (const lang of ['en', 'ru', 'he']) {
      const block = notify.slice(notify.indexOf(`  ${lang}: {`))
      const line = block.slice(0, block.indexOf('\n  },')).match(/task_due: '([^']*)'/)
      expect(line, `${lang} task_due`).toBeTruthy()
      expect(line![1]).not.toMatch(/\{actor\}/)
    }
  })
})

describe('срок и номер задачи на иврите', () => {
  const app = (p: string) => readFileSync(join(here, '../../../app/src', p), 'utf8')

  it('номер задачи изолирован от названия', () => {
    // Иначе двунаправленный алгоритм считает «TASK-2» и латинское название
    // одним куском, переставляет их и слепляет: «TASK-2test» справа налево.
    // Отступ этого не чинит — он рисуется по краям строчного бокса.
    const src = app('components/tabs/TasksTab.tsx')
    const row = src.slice(src.indexOf('{task.number}') - 400, src.indexOf('{task.number}') + 200)
    expect(row).toMatch(/dir="ltr"/)
    expect(row).toMatch(/unicode-bidi:isolate/)
    expect(src).toMatch(/<bdi>\{task\.title\}<\/bdi>/)
  })

  it('в таблице срок показан значком с подсказкой', () => {
    // В таблице нет места ни под дату, ни под «осталось столько-то».
    const dot = app('components/tabs/tasks/DueDot.tsx')
    expect(dot).toMatch(/title=\{/)
    // Цвет не единственный признак: подсказка повторяет всё словами.
    expect(dot).toMatch(/aria-label=\{/)
  })

  it('ступеней четыре, и выполненная задача не красится', () => {
    const types = app('components/tabs/tasks/types.ts')
    const fn = types.slice(types.indexOf('export function dueLevel'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toMatch(/t\.status === 'done'/)
    for (const level of ['overdue', 'urgent', 'soon', 'far']) {
      expect(body, level).toMatch(new RegExp(`'${level}'`))
    }
  })
})
