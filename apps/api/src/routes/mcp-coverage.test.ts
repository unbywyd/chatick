import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Что умеет мост — должно быть доступно и через MCP.
 *
 * Проверка check-mcp-sync.mjs ловит обратное: MCP зовёт ручку, которой нет.
 * А вот ручку, до которой MCP не довели, она не видит вовсе — и так тихо
 * потерялись целые разделы. Документов в проекте 69, блокеров 35, и ни одного
 * инструмента к ним не было; правка и удаление комментариев существовали в
 * мосту, но не в MCP.
 *
 * Пропуск не ломает ничего заметного: ассистент просто не знает, что так
 * можно, и человек считает, что продукт этого не умеет.
 *
 * Список ниже — не «все ручки моста», а те, без которых ассистент работать не
 * может. Часть непокрытого верна намеренно: /device и /guide MCP использует
 * иначе, /db/:id/read — прямой доступ к чужой базе, удаление проекта не даём
 * вовсе.
 */

const mcp = readFileSync(join(import.meta.dirname, '../../../mcp/src/tools.ts'), 'utf8')

/** Инструмент есть, если его имя объявлено в registerTool. */
const has = (tool: string) => new RegExp(`'${tool}'`).test(mcp)

describe('комментарии', () => {
  it('можно не только написать, но и поправить свой', () => {
    // Ассистент отписался в задаче и напутал. Без правки он может лишь
    // написать второй комментарий «выше ошибся», а неверный остаётся в ленте.
    expect(has('chatick_comment_update'), 'нет правки комментария').toBe(true)
    expect(has('chatick_comment_delete'), 'нет удаления комментария').toBe(true)
  })

  it('в описании сказано, что чужие трогать нельзя', () => {
    // Сервер и так откажет, но модель должна знать это до вызова, а не после.
    const at = mcp.indexOf("'chatick_comment_update'")
    expect(mcp.slice(at, at + 1200)).toMatch(/ONLY YOUR OWN/)
  })

  it('правку предпочитаем удалению', () => {
    // Удалённый комментарий оставляет дыру: тот, кто на него ответил,
    // отвечает в пустоту.
    const at = mcp.indexOf("'chatick_comment_delete'")
    expect(mcp.slice(at, at + 1200)).toMatch(/Prefer chatick_comment_update/)
  })
})

describe('документы', () => {
  it('их видно, читают и пишут', () => {
    // 69 документов в проекте: спеки и договорённости, по которым пишут код.
    for (const tool of ['chatick_documents', 'chatick_document', 'chatick_document_create']) {
      expect(has(tool), `нет инструмента ${tool}`).toBe(true)
    }
  })

  it('дописать в конец можно, не переписывая целиком', () => {
    // Документ пишут несколько человек: замена целиком молча стирает чужое.
    expect(has('chatick_document_append'), 'нет дописывания в документ').toBe(true)
    const at = mcp.indexOf("'chatick_document_update'")
    expect(mcp.slice(at, at + 1400), 'не сказано, что тело заменяется целиком').toMatch(/REPLACES the old one/)
  })
})

describe('блокеры', () => {
  it('видно, что держит работу, и можно это записать', () => {
    // Ни статус, ни прогресс не отвечают на «почему не движется».
    expect(has('chatick_blockers'), 'нет чтения блокеров').toBe(true)
    expect(has('chatick_blocker_add'), 'нет записи блокера').toBe(true)
  })
})

describe('спринты', () => {
  it('список есть — иначе задача молча уедет мимо спринта', () => {
    // chatick_task_create принимает ИМЯ спринта, а неизвестное имя не создаёт
    // новый: задача просто оказывается вне групп.
    expect(has('chatick_sprints'), 'нет списка спринтов').toBe(true)
  })
})

describe('чат', () => {
  it('переписку можно прочитать и написать в неё', () => {
    // 255 сообщений и 30 сводок, которых ассистент не видел. Странность была
    // вдвойне: инбокс он читал, а сам чат — нет, хотя решения принимаются там.
    for (const tool of ['chatick_chat_summaries', 'chatick_chat_search', 'chatick_chat_post']) {
      expect(has(tool), `нет инструмента ${tool}`).toBe(true)
    }
  })

  it('сказано, что задачное место — комментарий, а не чат', () => {
    // Иначе отчёт о работе уедет в ленту, которая прокрутится, вместо задачи,
    // где он останется рядом с работой.
    const at = mcp.indexOf("'chatick_chat_post'")
    expect(mcp.slice(at, at + 1400)).toMatch(/belongs to no task/)
  })
})

describe('связи задач', () => {
  it('их видно и можно поставить', () => {
    // Связей больше, чем блокеров: «эта выросла из той», «эти две про одно».
    expect(has('chatick_task_links'), 'нет чтения связей').toBe(true)
    expect(has('chatick_task_link'), 'нет создания связи').toBe(true)
  })

  it('сказано связывать при дроблении задачи', () => {
    // Пять новых задач без ниточки к исходной — потерянный след.
    const at = mcp.indexOf("'chatick_task_link'")
    expect(mcp.slice(at, at + 1400)).toMatch(/WHEN YOU SPLIT ONE TASK/)
  })
})

describe('файлы', () => {
  it('файл можно скачать, а не только увидеть имя', () => {
    // Загрузка была, скачивания нет: «посмотри тот лог» упиралось в то, что
    // открыть его нечем.
    expect(has('chatick_file_get'), 'нет скачивания файла').toBe(true)
    expect(has('chatick_files'), 'нет списка файлов').toBe(true)
  })

  it('скачивание идёт мимо call() — тот читает ответ текстом', () => {
    // Картинка или архив, прочитанные как текст, превращаются в мусор.
    //
    // Саботаж: перевести на call() — файлы будут скачиваться битыми.
    const bridge = readFileSync(join(import.meta.dirname, '../../../mcp/src/bridge.ts'), 'utf8')
    expect(bridge, 'нет отдельной функции скачивания').toMatch(/export async function download/)
    expect(bridge, 'байты не читаются как байты').toMatch(/new Uint8Array\(await res\.arrayBuffer\(\)\)/)
    const at = mcp.indexOf("'chatick_file_get'")
    expect(mcp.slice(at, at + 1500), 'скачивание идёт через call()').toMatch(/await download\(/)
  })
})

describe('чего в MCP быть не должно', () => {
  it('удаления проекта нет', () => {
    // Удаление уносит с собой всё и необратимо: решение человека в приложении.
    expect(mcp, 'появилось удаление проекта').not.toMatch(/chatick_project_delete/)
  })

  it('прямого чтения чужой базы нет', () => {
    // /x/db/:id/read даёт запросы в подключённую базу проекта — это не то,
    // что стоит открывать инструментом.
    expect(mcp, 'появился прямой доступ к базе').not.toMatch(/'\/db\//)
  })
})

/**
 * v2: мяч, быстрый ввод, уровень компании.
 *
 * Проверка покрытия писалась под первую версию и не знала, что работа теперь
 * движется передачами мяча, а у компании есть свои часы, документы и версии.
 * Без этого раздела инструмент можно было потерять, и тесты молчали бы.
 */
describe('v2: мяч', () => {
  const bridge = readFileSync(join(import.meta.dirname, './bridge.ts'), 'utf8')

  it('ходы, списки мяча, стол и быстрый ввод — в MCP', () => {
    for (const tool of ['chatick_ball', 'chatick_handoff', 'chatick_handoffs', 'chatick_table', 'chatick_quick_task']) {
      expect(has(tool), `нет инструмента ${tool}`).toBe(true)
    }
  })

  it('в списках мяча есть ссылка и доступные ходы', () => {
    // Без «moves» ассистент пробовал ход наугад и получал отказ; без «url»
    // собирал ссылку сам — и она вела в никуда.
    const at = bridge.indexOf("bridgeRoute.get('/ball/mine'")
    expect(bridge.slice(at, at + 700)).toMatch(/forAgent\(/)
    expect(bridge).toMatch(/async function movesFor/)
    const tool = mcp.indexOf("'chatick_ball'")
    expect(mcp.slice(tool, tool + 1500)).toMatch(/"moves"/)
  })

  it('на вопрос отвечают ходом answer, а не комментарием', () => {
    // Комментарий не возвращает мяч: спросивший ждёт дальше.
    const at = mcp.indexOf("'chatick_comment'")
    expect(mcp.slice(at, at + 1500)).toMatch(/action="answer"/)
    // И вопросы видны в «лично мне».
    expect(bridge).toMatch(/kind: r\.n\.event === 'task_handoff' \? 'question' : 'mention'/)
  })

  it('быстрый ввод: project — куда без #, company — у мастер-доступа, в ответе ссылка', () => {
    const at = mcp.indexOf("'chatick_quick_task'")
    const tool = mcp.slice(at, at + 1800)
    expect(tool).toMatch(/project: z\.string\(\)\.optional\(\)\.describe\('Where the task goes/)
    expect(tool).toMatch(/company: z\.string\(\)/)
    const q = bridge.indexOf("bridgeRoute.post('/ball/quick'")
    expect(bridge.slice(q, q + 2200)).toMatch(/defaultProjectId: def\?\.id/)
    expect(bridge.slice(q, q + 2200)).toMatch(/\.url = projectUrl/)
  })

  it('правка задачи меняет заголовок и описание', () => {
    // Схема их отбрасывала: ассистент «исправлял» описание, а оно оставалось прежним.
    const at = mcp.indexOf("'chatick_task_update'")
    const tool = mcp.slice(at, at + 3000)
    expect(tool).toMatch(/title: z\.string\(\)\.min\(1\)\.optional\(\)/)
    expect(tool).toMatch(/description: z\.string\(\)\.optional\(\)/)
  })
})

describe('v2: уровень компании', () => {
  it('часы, документы и версии всей компании', () => {
    for (const tool of ['chatick_company_time', 'chatick_company_documents', 'chatick_company_releases']) {
      expect(has(tool), `нет инструмента ${tool}`).toBe(true)
    }
  })

  it('время и заметки — и на компанию, без проекта', () => {
    for (const tool of ['chatick_timer_start', 'chatick_time_log', 'chatick_time_list', 'chatick_note_save']) {
      const at = mcp.indexOf(`'${tool}'`)
      expect(mcp.slice(at, at + 2500), `${tool}: нет onCompany`).toMatch(/onCompany/)
      // У мастер-доступа без company был 400 — параметра не было вовсе.
      expect(mcp.slice(at, at + 2500), `${tool}: нет company`).toMatch(/company: z\.string\(\)/)
    }
  })
})
