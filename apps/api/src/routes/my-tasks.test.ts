import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Панель «Мои задачи» — задачи по всем проектам компании (TASK-21).
 *
 * Отдельная ручка на session-токене: обходить проекты по одному нельзя,
 * project-токен на фронте один. Здесь заперто то, что при этом легко
 * ослабить незаметно — права, — и то, ради чего всё затевалось: панель не
 * должна мигать при переходе между задачами.
 */

const route = readFileSync(join(import.meta.dirname, 'tasks.ts'), 'utf8')
const app = (f: string) => readFileSync(join(import.meta.dirname, '../../../app/src', f), 'utf8')
const panel = app('components/chat/MyTasksPanel.tsx')
const chat = app('components/chat/ChatPanel.tsx')

/** Тело ручки: всё после её объявления. */
const handler = route.slice(route.indexOf("tasksMineRoute.get('/'"))

describe('мои задачи: сервер', () => {
  it('только свои и только там, где состоишь', () => {
    // Обе половины обязательны. Без первой человек увидит чужие задачи из
    // своих проектов, без второй — свои из проектов, куда его не звали.
    expect(handler, 'фильтр по исполнителю пропал').toMatch(/eq\(tasks\.assigneeId, sub\)/)
    expect(handler, 'проекты берутся не через членство').toMatch(/eq\(projectMembers\.userId, sub\)/)
  })

  it('удалённые задачи не показываются', () => {
    expect(handler).toMatch(/isNull\(tasks\.deletedAt\)/)
  })

  it('сделанные не показываются', () => {
    // Иначе панель утонет в закрытых.
    expect(handler).toMatch(/<> 'done'/)
  })

  it('порядок считает база, а не фронт', () => {
    // Сначала просроченные, потом от старых к новым.
    expect(handler).toMatch(/order[\s\S]{0,200}?dueDate[\s\S]{0,120}?asc\(tasks\.createdAt\)/)
  })

  it('просрочка меряется временем сервера', () => {
    // now() в SQL, а не время клиента: часы у клиента могут врать, и задача
    // считалась бы просроченной у одного и нет у другого.
    expect(handler).toMatch(/< now\(\)/)
  })

  it('без companyId ручка отказывает', () => {
    // Иначе показали бы задачи всех компаний разом.
    expect(handler).toMatch(/companyId required/)
  })
})

describe('мои задачи: панель', () => {
  it('список живёт на session-токене', () => {
    /**
     * Ключевое для всей затеи. Проектные данные вытираются при переключении
     * (dropProjectCache), а этот ключ в белом списке не нужен: запрос идёт с
     * session-токеном и своим ключом ['my-tasks', companyId] — на него сброс
     * проектного кэша не влияет, потому что он не проектный по адресу.
     */
    expect(panel).toMatch(/queryKey: \['my-tasks', companyId\]/)
    expect(panel, 'запрос ушёл на project-токен').not.toMatch(/'project'\)/)
  })

  it('клик уводит в задачу её проекта', () => {
    expect(panel).toMatch(/\/c\/\$\{companyId\}\/p\/\$\{task\.projectId\}\/tasks\/\$\{task\.id\}/)
  })

  it('переключатель не трогает режим чата', () => {
    /**
     * Задачи — вид панели, а не третий ChatMode. ChatMode уходит на сервер в
     * messages/seen и размечает прочитанное; третьим значением его расширять
     * нельзя. Вернувшись из задач, человек попадает в тот канал, из которого
     * ушёл.
     */
    expect(chat).toMatch(/const \[showTasks, setShowTasks\] = useState\(true\)/)
    expect(chat, 'задачи стали третьим ChatMode').not.toMatch(/ChatMode = 'group' \| 'ai' \| /)
  })

  it('горячие клавиши уводят со списка', () => {
    // Иначе жмёшь «в чат» и остаёшься в задачах: клавиша молча не работает.
    expect(chat).toMatch(/focusChat: \(\) => \{\s*setShowTasks\(false\)/)
    expect(chat).toMatch(/focusAi: \(\) => \{\s*setShowTasks\(false\)/)
  })

  it('поле ввода на списке не рендерится вовсе', () => {
    /**
     * Писать в задачу из чата нельзя, а пустое поле обещает обратное.
     *
     * Именно не рендерится, а не прячется классом hidden: скрытый элемент
     * остаётся в разметке с нулевыми размерами, и тур, ищущий цель через
     * querySelector, находил композер и ставил подсказку в угол экрана.
     */
    expect(chat).toMatch(/\{!showTasks && \(\s*<footer/)
    expect(chat, 'композер снова прячется классом').not.toMatch(/showTasks && 'hidden'/)
  })
})
