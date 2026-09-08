import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Плашка под карточкой человека раскрывается списком задач.
 *
 * «7 задач ждут дольше двух недель» называет число, но не показывает, какие.
 * Разбирать их человек всё равно пойдёт — вопрос лишь в том, обойдёт ли он
 * ради этого семь проектов вручную.
 *
 * Главное здесь: правило в ручке и правило, по которому считается флаг,
 * должны совпадать. Разойдись они — плашка скажет «7», а список покажет пять,
 * и доверие к цифрам кончится на первом же клике.
 */

const api = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8').replace(/\r\n/g, '\n')
const app = (p: string) =>
  readFileSync(join(import.meta.dirname, '../../../app/src/', p), 'utf8').replace(/\r\n/g, '\n')

const companies = api('routes/companies.ts')
const people = app('components/company/PeopleStats.tsx')
const handler = companies.slice(
  companies.indexOf("companiesRoute.get('/:companyId/people/:userId/flag/:flag'"),
  companies.indexOf("companiesRoute.get('/:companyId/workload'"),
)

describe('список за флагом совпадает с самим флагом', () => {
  it('stalled: не тронуто И старше двух недель', () => {
    // Дословно как over_2w в блоке rhythm: задача заведена больше двух недель
    // назад и исполнитель НИ РАЗУ её не тронул. Не «делает медленно», а не
    // начинал — в этом вся суть флага.
    //
    // Саботаж: убрать проверку first_touch — тест падает.
    expect(handler, 'ручка исчезла').toBeTruthy()
    expect(handler, 'нет порога в две недели').toContain("t.created_at < now() - interval '14 days'")
    expect(handler, 'не проверяется отсутствие касания').toContain('is null')
    // Касание — комментарий или действие САМОГО исполнителя, а не любого.
    expect(handler, 'касанием считается чужое действие').toContain('c2.author_id = t.assignee_id')
    expect(handler, 'касанием считается чужое действие в журнале').toContain('l.actor_id = t.assignee_id')
  })

  it('stalled не считает удалённые комментарии касанием', () => {
    // У комментариев теперь мягкое удаление: удалённый комментарий не должен
    // означать «человек взялся за задачу».
    //
    // Саботаж: убрать c2.deleted_at is null — тест падает.
    expect(handler, 'удалённый комментарий считается касанием').toContain('c2.deleted_at is null')
  })

  it('blocking: держит ЧУЖУЮ работу, а не свою', () => {
    // Свои задачи, ждущие своих же, никого не задерживают кроме самого
    // человека — ставить это в упрёк нельзя.
    // Проверка нужна в ДВУХ местах: в счётчике holds и в самом фильтре.
    // Одно исправленное вхождение оставляло бы вторую половину сломанной.
    //
    // Саботаж: убрать сравнение исполнителей в любом из двух — тест падает.
    const both = (handler.match(/dt.assignee_id is distinct from t.assignee_id/g) ?? []).length
    expect(both, 'сравнение исполнителей есть не везде').toBe(2)
  })

  it('в списке только незакрытые задачи', () => {
    // Закрытая задача никого не задерживает и никого не ждёт.
    expect(handler, 'в списке есть закрытые').toContain("t.status not in ('done','verified')")
  })

  it('флаги без списка отвечают отказом, а не пустотой', () => {
    // «Очередь растёт», «размазан по проектам» говорят о РАСПРЕДЕЛЕНИИ
    // очереди; списка за ними нет. Пустой список выглядел бы как «всё
    // в порядке» — а это неправда.
    //
    // Саботаж: убрать проверку — тест падает.
    expect(handler, 'нераскрываемые флаги не отсекаются').toContain(
      "if (flag !== 'stalled' && flag !== 'blocking')",
    )
  })

  it('чужие проекты помечены, а не открываются отказом', () => {
    // Тот же приём, что в модалках просрочки и блокеров.
    expect(handler, 'нет признака членства').toContain('isMember: mine.has(r.projectId)')
  })
})

describe('плашка кликабельна только там, где есть что показать', () => {
  it('раскрываются ровно те же два флага', () => {
    // Правило дублируется на клиенте — иначе стрелка обещала бы список там,
    // где сервер ответит отказом.
    //
    // Саботаж: сделать openable всегда true — тест падает.
    expect(people, 'клиент не различает раскрываемые флаги').toContain(
      "const openable = f === 'stalled' || f === 'blocking'",
    )
    expect(people, 'нераскрываемая плашка стала кнопкой').toContain(
      'if (!openable) return <p key={f} className={cls}>{flagText[f]}</p>',
    )
  })

  it('у кликабельной плашки есть стрелка', () => {
    // Единственный признак, что по ней можно нажать: курсор на телефоне не
    // наведёшь. rtl:rotate-180 — в иврите «дальше» это влево.
    //
    // Саботаж: убрать ChevronRight — тест падает.
    expect(people, 'стрелки нет').toContain('<ChevronRight className="mt-0.5 size-3.5 shrink-0 rtl:rotate-180" />')
  })

  it('модалка знает, чьи задачи показывает', () => {
    // RhythmBlock получает только ритм — id человека приходится прокидывать
    // отдельно, иначе список будет чужой.
    expect(people, 'блок не знает человека').toContain('userId={p.id}')
    expect(people, 'модалка не получает человека').toContain('userId={userId}')
  })
})

describe('переводы модалки есть во всех языках', () => {
  for (const loc of ['ru', 'en', 'he'] as const) {
    it(loc, () => {
      const j = JSON.parse(
        readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${loc}.json`), 'utf8'),
      )
      expect(j.people?.flagEmpty, `нет people.flagEmpty в ${loc}`).toBeTruthy()
      // Формы — у Intl, а не по памяти: у иврита есть двойственное число.
      const pr = new Intl.PluralRules(loc)
      for (const form of [...new Set([1, 2, 3, 5, 11, 21, 100].map((n) => pr.select(n)))]) {
        expect(j.people?.[`flagDays_${form}`], `нет people.flagDays_${form}`).toBeTruthy()
      }
    })
  }
})
