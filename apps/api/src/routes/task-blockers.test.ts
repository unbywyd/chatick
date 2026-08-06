import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Зависимости между задачами: «эта ждёт ту».
//
// Опасность здесь одна и она тихая: кольцо. A ждёт B ждёт A — и обе задачи
// невозможно закрыть НИКОГДА, потому что каждая ждёт другую. Заметить это по
// интерфейсу нельзя: на каждом шаге связь выглядит осмысленной.

const src = readFileSync(join(import.meta.dirname, 'tasks.ts'), 'utf8')

function handler(method: string, path: string): string {
  // Аргумент бывает на той же строке и на следующей — якорь не должен от
  // этого зависеть, иначе тест «зеленеет» просто потому, что не нашёл ручку.
  const re = new RegExp(`tasksRoute\\.${method}\\(\\s*'${path.replace(/[/:]/g, (m) => `\\${m}`)}'`)
  const m = re.exec(src)
  expect(m, `ручка ${method.toUpperCase()} ${path} не найдена`).not.toBeNull()
  const rest = src.slice(m!.index + 20)
  const end = rest.indexOf('tasksRoute.')
  return rest.slice(0, end === -1 ? undefined : end)
}

describe('кольца запрещены', () => {
  const body = handler('post', '/:taskId/blockers')

  it('проверка идёт ДО вставки, а не после', () => {
    const check = body.indexOf('forbidden')
    const insert = body.search(/\.insert\(taskBlockers\)/)
    expect(check).toBeGreaterThan(-1)
    expect(insert).toBeGreaterThan(check)
  })

  it('проверяется транзитивно, а не только прямая пара', () => {
    // A→B→C→A на каждом шаге выглядит невинно, поэтому одной проверки
    // «не связаны ли эти двое напрямую» мало.
    expect(body).toMatch(/dependentsOf|blockersOf/)
    expect(src).toMatch(/async function dependentsOf/)
    expect(src).toMatch(/async function blockersOf/)
  })

  it('обход идёт вширь по всей цепочке, а не на один шаг', () => {
    const fn = src.slice(src.indexOf('async function dependentsOf'))
    expect(fn).toMatch(/while \(frontier\.length\)/)
    // Без множества посещённых обход по кольцу не закончился бы никогда.
    expect(fn).toMatch(/seen\.has/)
  })

  it('отказ называет задачи, а не просто «нельзя»', () => {
    expect(body).toMatch(/Circular dependency/)
    expect(body).toMatch(/looped\.map/)
  })

  it('задача не может ждать саму себя', () => {
    expect(body).toMatch(/cannot block itself/)
  })
})

describe('связи не выходят за проект', () => {
  const body = handler('post', '/:taskId/blockers')

  it('все задачи — из этого же проекта', () => {
    // Иначе в списке зависимостей появилась бы задача, к которой у человека
    // может не быть доступа.
    expect(body).toMatch(/not in this project/)
    expect(body).toMatch(/eq\(tasks\.projectId, projectId\)/)
  })

  it('правка связей требует права на правку задач', () => {
    expect(body).toMatch(/hasPermission\(projectId, sub, 'tasks\.edit'\)/)
  })
})

describe('счётчики для списка', () => {
  const list = src.slice(src.indexOf("tasksRoute.get('/'"), src.indexOf("tasksRoute.post('/'"))

  it('считаются одним запросом вместе со списком', () => {
    // Отдельный запрос на строку — это N+1 на таблицу в тысячу задач.
    expect(list).toMatch(/blockedBy: sql/)
    expect(list).toMatch(/blocking: sql/)
  })

  it('замочек гаснет сам: ждём только НЕзакрытые', () => {
    // Связь переживает завершение блокера — это факт о работе. Но задача,
    // все блокеры которой сделаны, заблокированной уже не считается.
    const m = list.slice(list.indexOf('blockedBy: sql'), list.indexOf('blocking: sql'))
    expect(m).toMatch(/bt\.status <> 'done'/)
  })

  it('удалённые задачи в счёт не идут', () => {
    expect(list).toMatch(/bt\.deleted_at is null/)
    expect(list).toMatch(/dt\.deleted_at is null/)
  })
})

describe('кандидаты на связь', () => {
  const body = handler('get', '/:taskId/blockers/candidates')

  it('заведомо запрещённые не предлагаются', () => {
    // Дать выбрать и ответить отказом — худший вид подсказки: решение уже
    // принято, а причину надо угадывать.
    expect(body).toMatch(/forbidden\.has/)
    expect(body).toMatch(/already\.has/)
    expect(body).toMatch(/r\.task\.id !== taskId/)
  })

  it('ищет по номеру, названию и своим номерам', () => {
    expect(body).toMatch(/tasks\.title.*ilike/s)
    expect(body).toMatch(/tasks\.number.*ilike/s)
    expect(body).toMatch(/tasks\.refs.*ilike/s)
  })
})

// --- Мост -------------------------------------------------------------------
//
// Ассистент разбирает макет целиком и первым видит порядок работ. Но связь,
// созданная через мост, обязана подчиняться тем же правилам, что и в вебе, —
// иначе мост становится дырой в защите от колец.

const bridge = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')
const guide = readFileSync(join(import.meta.dirname, '../lib/bridge-docs.ts'), 'utf8')

describe('зависимости через мост', () => {
  it('ручки есть: читать, ставить, снимать', () => {
    expect(bridge).toMatch(/bridgeRoute\.get\('\/tasks\/:id\/blockers'/)
    expect(bridge).toMatch(/bridgeRoute\.post\('\/tasks\/:id\/blockers'/)
    expect(bridge).toMatch(/bridgeRoute\.delete\('\/tasks\/:id\/blockers\/:linkId'/)
  })

  it('проверка колец — ОБЩАЯ с вебом, а не своя копия', () => {
    // Разойдись они, и через мост стало бы можно то, что запрещено в
    // интерфейсе, — а заметили бы это по трём мёртвым задачам.
    expect(bridge).toMatch(/dependentsOf|blockersOf/)
    expect(bridge).toMatch(/from '\.\/tasks\.js'/)
    expect(bridge).not.toMatch(/async function dependentsOf/)
  })

  it('кольцо отвергается до вставки и с объяснением', () => {
    const body = bridge.slice(bridge.indexOf("bridgeRoute.post('/tasks/:id/blockers'"))
    const check = body.indexOf('Circular dependency')
    const insert = body.search(/\.insert\(taskBlockers\)/)
    expect(check).toBeGreaterThan(-1)
    expect(insert).toBeGreaterThan(check)
  })

  it('задачи называются номером, а не только id', () => {
    // Ассистент оперирует TASK-4; заставлять его искать uuid — лишний круг.
    expect(bridge).toMatch(/async function taskByKey/)
    expect(bridge).toMatch(/eq\(tasks\.number, raw\.toUpperCase\(\)\)/)
  })

  it('правка связей требует права на правку задач', () => {
    const body = bridge.slice(bridge.indexOf("bridgeRoute.post('/tasks/:id/blockers'"))
    expect(body).toMatch(/require\(c as never, 'tasks\.edit'/)
  })

  it('счётчики едут вместе со списком, а не запросом на задачу', () => {
    expect(bridge).toMatch(/async function depCounts/)
    expect(bridge).toMatch(/openBlockers/)
  })
})

describe('гайд про зависимости', () => {
  it('перечисляет ручки', () => {
    expect(guide).toMatch(/GET    \/x\/tasks\/<id>\/blockers/)
    expect(guide).toMatch(/POST   \/x\/tasks\/<id>\/blockers/)
    expect(guide).toMatch(/DELETE \/x\/tasks\/<id>\/blockers/)
  })

  it('объясняет обе стороны связи', () => {
    expect(guide).toMatch(/side="blockedBy"/)
    expect(guide).toMatch(/side="blocking"/)
  })

  it('запрещает «прибираться», удаляя связи после закрытия', () => {
    // История «что чего ждало» — единственный способ объяснить простой.
    expect(guide).toMatch(/SURVIVES the blocker being finished/)
  })

  it('объясняет, почему кольцо — это тупик', () => {
    expect(guide).toMatch(/NEITHER can\s+ever be finished/)
  })

  it('велит не предлагать заблокированную работу', () => {
    expect(guide).toMatch(/openBlockers > 0 means the work/)
  })
})

// Подзапрос со счётчиками сам обращается к tasks — значит внешняя таблица
// ОБЯЗАНА быть под алиасом. Без него «id» разрешается во внутреннюю таблицу из
// join, Postgres отвечает «column reference is ambiguous», и весь список задач
// падает с 500. Тип-чекер такого не ловит: SQL для него строка.
describe('счётчики моста не ломают список', () => {
  const fn = bridge.slice(bridge.indexOf('async function depCounts'), bridge.indexOf('// --- Задачи'))

  it('внешняя задача — под алиасом, а не голым tasks', () => {
    expect(fn).toMatch(/outer_t/)
    // Ссылка на внешнюю строку должна идти через алиас в ОБОИХ подзапросах.
    const refs = fn.match(/= outer_t\.id/g) ?? []
    expect(refs.length).toBeGreaterThanOrEqual(2)
  })

  it('неквалифицированной ссылки на id не осталось', () => {
    // Ровно та строка, что роняла GET /x/tasks.
    expect(fn).not.toMatch(/blocked_task_id = \$\{tasks\.id\}/)
    expect(fn).not.toMatch(/blocker_task_id = \$\{tasks\.id\}/)
  })
})

describe('задачу можно звать номером во всех ручках', () => {
  it('одиночный GET принимает номер, а не только id', () => {
    // Иначе у соседних ручек две разные привычки: /blockers берёт TASK-81,
    // а GET задачи — нет. На этом ассистент и спотыкался.
    const body = bridge.slice(bridge.indexOf("bridgeRoute.get('/tasks/:id'"))
    expect(body.slice(0, 900)).toMatch(/eq\(tasks\.number, key\.toUpperCase\(\)\)|taskByKey/)
  })

  it('restore ищет ВКЛЮЧАЯ удалённые', () => {
    // taskByKey отдаёт только живые. Подставить его сюда — значит навсегда
    // сломать восстановление: удалённая задача просто не найдётся.
    // Ровно до следующей ручки: дальше taskByKey встречается законно.
    const from = bridge.indexOf("bridgeRoute.post('/tasks/:id/restore'")
    const rest = bridge.slice(from + 20)
    const body = rest.slice(0, rest.indexOf('bridgeRoute.'))
    // Проверяем ВЫЗОВ, а не упоминание: в комментарии рядом объясняется,
    // почему общий помощник здесь не годится.
    expect(body).not.toMatch(/await taskByKey\(/)
    expect(body).toMatch(/findFirst/)
    expect(body).toMatch(/not in the trash/)
  })
})

// Что держит проект целиком — одной ручкой.
//
// Собрать это из /x/tasks ассистент мог и раньше, но ошибка здесь тихая:
// назовёшь не того ответственного — человек пойдёт торопить постороннего.
describe('GET /x/blockers — обзор по проекту', () => {
  const body = bridge.slice(bridge.indexOf("bridgeRoute.get('/blockers'"), bridge.indexOf("bridgeRoute.get('/tasks/:id/blockers'"))

  it('объявлена раньше /tasks/:id/blockers и не конфликтует с ней', () => {
    expect(bridge.indexOf("bridgeRoute.get('/blockers'")).toBeGreaterThan(-1)
    expect(bridge.indexOf("bridgeRoute.get('/blockers'")).toBeLessThan(
      bridge.indexOf("bridgeRoute.get('/tasks/:id/blockers'"),
    )
  })

  it('завершённые не считаются держащими — с обеих сторон связи', () => {
    // Закрытая задача никого не держит, хотя связь остаётся историей.
    expect(body).toMatch(/tasks\.status\} <> 'done'/)
    expect(body).toMatch(/blocked\.status <> 'done'/)
  })

  it('удалённые тоже не в счёт', () => {
    expect(body).toMatch(/isNull\(tasks\.deletedAt\)/)
    expect(body).toMatch(/blocked\.deleted_at is null/)
  })

  it('отдаёт ответственного, а не только задачу', () => {
    expect(body).toMatch(/owner:/)
    expect(body).toMatch(/leftJoin\(users/)
  })

  it('ничьи задачи не прячет: спросить не с кого — это тоже ответ', () => {
    expect(body).toMatch(/blockerAssigneeId \?/)
  })

  it('ссылки на задачи — полные, по ним можно перейти', () => {
    expect(body).toMatch(/projectPath\(companyId, scope\.projectId/)
    expect(body).toMatch(/url\(r\.blockerId\)/)
    expect(body).toMatch(/url\(r\.blockedId\)/)
  })

  it('сверху тот, кто держит больше всех', () => {
    expect(body).toMatch(/sort\(\(a, b\) => b\.blocks\.length - a\.blocks\.length\)/)
  })

  it('ждущие считаются по головам, а не суммой', () => {
    // Задача, ждущая двоих, в сумме учлась бы дважды — на живом проекте это
    // давало 26 вместо 22.
    expect(body).toMatch(/new Set\(rows\.map\(\(r\) => r\.blockedId\)\)\.size/)
    expect(body).toMatch(/blocks: Set<string>/)
  })

  it('одним запросом, а не по задаче за раз', () => {
    expect((body.match(/await db/g) ?? []).length).toBe(1)
  })
})

describe('превью ссылок', () => {
  const preview = readFileSync(join(import.meta.dirname, 'link-preview.ts'), 'utf8')

  it('логотип берётся по цепочке: проект → компания → приложение', () => {
    // Логотип есть далеко не у каждого проекта, а у компании обычно есть.
    // Без средней ступеньки превью почти всегда показывало значок Chatick —
    // то есть узнать по картинке, куда зовут, было нельзя.
    expect(preview).toMatch(/projects\/\$\{projectId\}\/logo/)
    expect(preview).toMatch(/companies\/\$\{company\.id\}\/logo/)
  })

  it('запасная картинка — существующий файл, а не путь наугад', () => {
    // У SPA любой несуществующий путь отдаёт index.html с кодом 200: «картинка»
    // молча оказывается страницей, превью выходит без изображения, и ошибки
    // при этом нигде не видно.
    expect(preview).toMatch(/logo\.png/)
    expect(preview).not.toMatch(/icon-512\.png/)
  })

  it('адрес для человека — без префикса монтирования', () => {
    // c.req.path отдаёт «/link/c/…»; с ним ссылка из превью не открывает
    // приложение.
    expect(preview).toContain(String.raw`replace(/^\/link/`)
    expect(preview).not.toContain('${APP()}/#${c.req.path}')
  })
})
