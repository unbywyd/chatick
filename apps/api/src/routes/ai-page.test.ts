import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Страница ИИ проекта: табы, права и проверка ключа.
 *
 * Настройки ИИ были размазаны по трём экранам — источник и ключ на /ai,
 * поведение и правила в настройках проекта, ключ компании в третьем месте.
 * Собрали в одно, и здесь заперто то, что при этом легко сломать назад.
 */

const app = (f: string) => readFileSync(join(import.meta.dirname, '../../../app/src', f), 'utf8')
const tab = app('components/tabs/AiUsageTab.tsx')
const main = app('main.tsx')
const form = app('components/ProjectSettingsForm.tsx')
const fields = app('components/AiBehaviorFields.tsx')
const route = readFileSync(join(import.meta.dirname, 'ai.ts'), 'utf8')

describe('страница ИИ: табы через роутинг', () => {
  it('таб берётся из адреса, а не из состояния', () => {
    // Иначе ссылкой на таб не поделиться и обновление страницы его теряет.
    expect(main, 'маршрут без необязательного сегмента таба').toMatch(/path="ai\/:aiTab\?"/)
    expect(tab, 'таб не читается из useParams').toMatch(/const \{ companyId, aiTab \} = useParams\(\)/)
  })

  it('чужой таб в адресе откатывается к дефолту, а не роняет экран', () => {
    expect(tab).toMatch(/AI_TABS\.includes\(aiTab as AiTab\) \? \(aiTab as AiTab\) : 'settings'/)
  })

  it('переключение таба не копит историю', () => {
    // Без replace кнопка «назад» отматывает по табам вместо ухода со страницы.
    expect(tab).toMatch(/navigate\([^)]*\{ replace: true \}\)/)
  })
})

describe('перенос настроек поведения', () => {
  it('разметка одна на оба места', () => {
    // Копия разошлась бы: правку внесли в одно место, второе молча отстало.
    expect(form, 'форма настроек не использует общий компонент').toMatch(/<AiBehaviorFields/)
    expect(tab, 'страница ИИ не использует общий компонент').toMatch(/<AiBehaviorFields/)
  })

  it('общий компонент ничего не сохраняет сам', () => {
    /**
     * Договор: только разметка. В форме настроек поля сохраняются общей
     * кнопкой (в том числе при СОЗДАНИИ проекта, когда сохранять некуда), а
     * на странице ИИ — своим запросом. Появись запрос внутри — на создании
     * проекта он бы ушёл в никуда.
     */
    expect(fields).not.toMatch(/useMutation|useQuery|api\(/)
  })

  it('на странице ИИ у полей есть своё сохранение', () => {
    // Без него поля выглядят рабочими и молча ничего не делают.
    // Проверяем всю цепочку: запрос объявлен, шлёт PATCH настроек проекта и
    // висит на кнопке. Одного имени мало — переименуй его, и тест бы прошёл.
    expect(tab, 'нет мутации сохранения поведения').toMatch(
      /const saveBehavior = useMutation\(\{[\s\S]{0,400}?method: 'PATCH'/,
    )
    expect(tab, 'сохранение ни к чему не привязано').toMatch(/onClick=\{\(\) => saveBehavior\.mutate\(\)\}/)
  })

  it('вкладка ИИ осталась в форме — она нужна при создании проекта', () => {
    expect(form).toMatch(/FORM_TABS = \[[^\]]*'ai'/)
  })
})

describe('права на настройки ИИ проекта', () => {
  it('начальство проекта либо начальство компании', () => {
    // Админ компании менял общий ключ компании, но не ключ её же проекта,
    // если сам в проекте не состоял.
    expect(route, 'нет общей проверки прав').toMatch(/async function mayManageAi/)
    expect(route).toMatch(/canCreateProjects\(await companyRoleOf\(project\.companyId, userId\)\)/)
  })

  it('обе изменяющие ручки закрыты ею же', () => {
    const puts = [...route.matchAll(/aiRoute\.put\([\s\S]{0,400}?c\.json\(\{ error: 'Forbidden' \}, 403\)/g)]
    expect(puts.length, 'ручка сохранения перестала проверять права').toBe(2)
    for (const m of puts) expect(m[0]).toMatch(/mayManageAi/)
  })

  it('фронт пропускает ровно тех же, кого сервер', () => {
    // canCreateProjects на сервере — это admin ИЛИ manager. Разойдись списки,
    // человек получил бы кнопку, дающую отказ.
    expect(main).toMatch(/companyRole === 'admin' \|\| companyRole === 'manager'/)
  })
})

describe('ключ проекта проверяется до сохранения', () => {
  it('живым запросом, с причиной от провайдера', () => {
    // Иначе неверный ключ ложится молча и всплывает потом в чате общим
    // «не получилось получить ответ» — отладка вслепую.
    expect(route).toMatch(/const check = await testLlm\(/)
    expect(route).toMatch(/c\.json\(\{ error: check\.reason \}, 422\)/)
  })

  it('ключ наружу по-прежнему не отдаётся', () => {
    // Только признак наличия: сам ключ не показываем никому и никогда.
    expect(route).toMatch(/hasKey: Boolean\(ai\?\.keyEncrypted\)/)
    expect(route, 'ключ утекает в ответ').not.toMatch(/keyEncrypted:\s*ai\?\.keyEncrypted[,\s}]/)
  })
})
