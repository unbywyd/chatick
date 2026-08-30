import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Журнал работы: два правила, на которых держится всё остальное.
 *
 * 1. Черновик виден ТОЛЬКО автору — ни списком, ни поиском, ни мостом.
 *    Сломается это правило — в журнал перестанут писать честно, а честность
 *    единственное, ради чего он заведён. Причём сломается тихо: чужой
 *    черновик в выдаче выглядит как обычная запись.
 *
 * 2. Опубликованное не правится. Журнал, который переписывают задним числом,
 *    перестаёт отвечать на вопрос «что я делал в марте».
 *
 * Проверяем по тексту кода, а не по живым запросам: в этом проекте так
 * устроены все сторожа прав (knowledge-access, permission-domains).
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8')
const worklog = read('worklog.ts')
const embeddings = readFileSync(join(import.meta.dirname, '../lib/embeddings.ts'), 'utf8')

describe('черновик виден только автору', () => {
  it('видимость в списке — одним выражением, а не двумя фильтрами по очереди', () => {
    // Саботаж: заменить or(...) на eq(status,'published') — черновики
    // исчезнут даже у автора; заменить на push двух условий подряд — легко
    // получить все черновики. Требуем именно связку or(автор, опубликовано).
    const at = worklog.indexOf("worklogRoute.get('/'")
    const list = worklog.slice(at, worklog.indexOf("worklogRoute.get('/authors'"))
    const norm = list.replace(/\s+/g, ' ')
    expect(
      norm,
      'граница видимости не собрана в одно выражение or(автор, опубликовано)',
    ).toMatch(/const visible = or\( eq\(workLog\.authorId, sub\), eq\(workLog\.status, 'published'\), \)!/)
    expect(norm, 'выражение видимости не применено к запросу').toContain('conds.push(visible)')
  })

  it('участник заперт на себе, что бы он ни просил', () => {
    // Саботаж: убрать !seesEveryone и оставить только ветку с q.authorId —
    // участник получит чужие записи, подставив чужой id в адрес.
    const at = worklog.indexOf("worklogRoute.get('/'")
    const list = worklog.slice(at, worklog.indexOf("worklogRoute.get('/authors'"))
    const norm = list.replace(/\s+/g, ' ')
    expect(norm).toContain('if (!seesEveryone) conds.push(eq(workLog.authorId, sub))')
    // И фильтр по чужому автору доступен ТОЛЬКО начальству — через else.
    expect(norm, 'фильтр по автору применяется и без проверки прав').toMatch(
      /if \(!seesEveryone\) conds\.push\(eq\(workLog\.authorId, sub\)\) else if \(q\.authorId\)/,
    )
  })

  it('«всех видит» — это owner или admin проекта, а не любой участник', () => {
    const at = worklog.indexOf('async function canSeeEveryone')
    const fn = worklog.slice(at, at + 400)
    expect(fn).toMatch(/m\?\.role === 'owner' \|\| m\?\.role === 'admin'/)
  })

  it('черновик не попадает в индекс поиска ВООБЩЕ', () => {
    // Главный замок: чего нет в индексе, то не найдёт никакой поиск — ни
    // нынешний, ни тот, который напишут через год.
    //
    // Саботаж: убрать проверку статуса в textOf — черновики начнут
    // индексироваться, и ассистент процитирует чужой.
    const at = embeddings.indexOf("if (entityType === 'work_log')")
    expect(at, 'ветка work_log в textOf не найдена').toBeGreaterThan(-1)
    // До КОНЦА ветки, а не до первого return null: первый — это проверка на
    // удалённую запись, и обрезав по нему, мы бы смотрели мимо статуса.
    const branch = embeddings.slice(at, embeddings.indexOf('\n  }', at))
    expect(branch, 'в индекс попадает не только опубликованное').toMatch(
      /if \(w\.status !== 'published'\) return null/,
    )
    // И проверка стоит ДО обращения к тексту, а не после: считать вектор
    // черновика, а потом его выбросить — значит платить за то, чего нельзя
    // показывать.
    expect(branch.indexOf("w.status !== 'published'")).toBeLessThan(branch.indexOf('htmlToText'))
  })

  it('поиск по словам тоже отсеивает чужие черновики — второй замок', () => {
    // Индекс и словесный поиск — разные пути, и защита нужна в обоих:
    // включи кто-нибудь однажды индексацию черновиков, словесная выдача
    // осталась бы единственной преградой.
    const at = embeddings.indexOf('export async function searchWorkLogIds')
    expect(at, 'searchWorkLogIds не найдена').toBeGreaterThan(-1)
    const fn = embeddings.slice(at, embeddings.indexOf('export async function', at + 100))
    const norm = fn.replace(/\s+/g, ' ')
    expect(norm).toContain(
      "const visible = or(eq(workLog.authorId, opts.userId), eq(workLog.status, 'published'))!",
    )
    expect(norm, 'выражение видимости не применено к отбору по словам').toMatch(/visible,/)
  })
})

describe('опубликованное не меняется', () => {
  it('правка отвергает всё, кроме черновика', () => {
    // Саботаж: убрать проверку или сравнить с 'published' наоборот.
    const at = worklog.indexOf("worklogRoute.patch('/:id'")
    const fn = worklog.slice(at, worklog.indexOf('worklogRoute.post', at))
    expect(fn).toMatch(/if \(row\.status !== 'draft'\) return c\.json\(\{ error: 'published_is_final' \}, 409\)/)
  })

  it('чужую запись не правит никто, включая владельца проекта', () => {
    const at = worklog.indexOf("worklogRoute.patch('/:id'")
    const fn = worklog.slice(at, worklog.indexOf('worklogRoute.post', at))
    expect(fn).toMatch(/if \(row\.authorId !== sub\) return c\.json\(\{ error: 'forbidden' \}, 403\)/)
  })

  it('публикация — переход в одну сторону, повторная отвергается', () => {
    const at = worklog.indexOf("worklogRoute.post('/:id/publish'")
    const fn = worklog.slice(at, worklog.indexOf('worklogRoute.delete', at))
    expect(fn).toMatch(/if \(row\.status !== 'draft'\) return c\.json\(\{ error: 'already_published' \}, 409\)/)
    // Обратной ручки нет вовсе: снять публикацию значит переписать историю.
    //
    // Без /s: с ним точка перескакивает через строки, и «status: 'draft'» из
    // создания записи склеивается с любым update ниже по файлу — проверка
    // падала бы на исправном коде. Ищем то, что действительно означает откат:
    // маршрут с таким именем и снятие статуса в update.
    expect(worklog, 'появился маршрут снятия публикации').not.toMatch(/unpublish/i)
    expect(worklog, 'публикация где-то снимается через update').not.toMatch(
      /\.set\(\{[^}]*status: 'draft'/,
    )
    expect(worklog, 'publishedAt где-то обнуляется').not.toMatch(/publishedAt: null/)
  })
})

describe('удаление', () => {
  it('своё — любое, чужое — никакое', () => {
    const at = worklog.indexOf("worklogRoute.delete('/:id'")
    const fn = worklog.slice(at)
    expect(fn).toMatch(/if \(row\.authorId !== sub\) return c\.json\(\{ error: 'forbidden' \}, 403\)/)
    // Статус не проверяется: удалить можно и опубликованное — «удалять любые».
    expect(fn, 'удаление опубликованного запрещено, а должно быть можно').not.toMatch(/status !== 'draft'/)
  })

  it('через мост ЛЛМ стирает только черновик', () => {
    // Черновик ассистент чаще всего сам и написал — «не то, сотри» обычный
    // ответ. Опубликованное он не трогает: на него сослались, оно часть
    // истории, и стереть его случайно проще, чем написать.
    //
    // Саботаж: убрать проверку статуса — ЛЛМ сможет стирать опубликованное.
    // Проверяем ЭНДПОИНТ, а не описание инструмента: описание — просьба к
    // модели, а не запрет.
    const bridge = read('bridge.ts')
    const at = bridge.indexOf("bridgeRoute.delete('/worklog/:id'")
    expect(at, 'ручка удаления журнала в мосту не найдена').toBeGreaterThan(-1)
    const fn = bridge.slice(at, bridge.indexOf('bridgeRoute.', at + 50))
    expect(fn, 'мост стирает не только черновики').toMatch(/if \(row\.status !== 'draft'\)/)
    expect(fn).toMatch(/if \(row\.authorId !== id\.userId\)/)
  })

  it('удалённое уходит из поиска', () => {
    // Иначе запись стёрта, а ассистент её цитирует.
    const at = worklog.indexOf("worklogRoute.delete('/:id'")
    expect(worklog.slice(at)).toMatch(/void enqueue\('work_log', id, projectId\)/)
  })
})

describe('черновик один', () => {
  it('правило держит база, а не проверка в коде', () => {
    // Саботаж: убрать индекс из миграции — две вкладки заведут два черновика,
    // и «править последнюю до публикации» потеряет смысл.
    const sql = readFileSync(join(import.meta.dirname, '../../drizzle/0094_work_log.sql'), 'utf8')
    const norm = sql.replace(/\s+/g, ' ')
    expect(norm).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "work_log_one_draft_idx" ON "work_log" \("project_id", "author_id"\) WHERE "status" = 'draft' AND "deleted_at" IS NULL/,
    )
  })

  it('второй черновик получает внятный ответ, а не ошибку базы', () => {
    const at = worklog.indexOf("worklogRoute.post('/'")
    const fn = worklog.slice(at, worklog.indexOf("worklogRoute.patch('/:id'"))
    expect(fn).toMatch(/return c\.json\(\{ error: 'draft_exists', id: open\.id \}, 409\)/)
  })
})

describe('«где я остановился» — ответ отдельным полем', () => {
  const bridge = read('bridge.ts')
  const at = bridge.indexOf("bridgeRoute.get('/worklog'")
  const fn = bridge.slice(at, bridge.indexOf('bridgeRoute.post', at))

  it('latestOwn берётся из СВОИХ записей, а не из первой строки списка', () => {
    // Саботаж: latestOwn = items[0] — в проекте на десять человек это будет
    // чужая запись, и «где я остановился» ответит про кого-то другого.
    expect(fn.replace(/\s+/g, ' ')).toContain('const mine = items.filter((x) => x.mine)')
    expect(fn, 'latestOwn не привязан к своим записям').toMatch(/latestOwn = mine\./)
  })

  it('свой черновик важнее своего опубликованного, даже если он старше', () => {
    // Черновик — незаконченная мысль, оставленная себе; опубликованное уже
    // подытожено. На вопрос «где я встал» отвечает первое.
    expect(fn.replace(/\s+/g, ' ')).toContain(
      "const latestOwn = mine.find((x) => x.status === 'draft') ?? mine[0] ?? null",
    )
  })

  it('пустой журнал не отдаёт undefined, а говорит, что делать', () => {
    // `mine[0]` на пустом массиве — undefined, и поле бы просто исчезло из
    // ответа: модель не отличит «нет записей» от «поле не завезли».
    expect(fn).toMatch(/\?\? null/)
    expect(fn, 'нет подсказки для пустого журнала').toMatch(/has written nothing here yet/)
  })

  it('признак «моё» есть у каждой записи', () => {
    expect(fn).toMatch(/mine: x\.r\.authorId === id\.userId/)
  })
})

describe('связь с задачей', () => {
  it('отвязка пустой строкой не кладёт «» вместо пустоты', () => {
    // Пустая строка — тоже строка. Без .trim() сюда легло бы taskId: ''
    // — внешний ключ на несуществующую задачу, то есть ошибка базы вместо
    // отвязки.
    //
    // Саботаж: вернуть typeof b.taskId === 'string' ? b.taskId : null.
    const bridge = read('bridge.ts')
    const at = bridge.indexOf("bridgeRoute.patch('/worklog/:id'")
    const fn = bridge.slice(at, bridge.indexOf('bridgeRoute.post', at))
    expect(fn.replace(/\s+/g, ' '), 'пустая строка не превращается в null').toContain(
      "patch.taskId = typeof b.taskId === 'string' && b.taskId.trim() ? b.taskId.trim() : null",
    )
  })
})

describe('лента', () => {
  it('стоит по времени публикации, а не создания', () => {
    // Черновик пишут в понедельник, публикуют в пятницу: в ленте он должен
    // встать пятницей, иначе опубликованное сегодня уезжает в прошлую неделю.
    const at = worklog.indexOf("worklogRoute.get('/'")
    const list = worklog.slice(at, worklog.indexOf("worklogRoute.get('/authors'"))
    expect(list).toMatch(/coalesce\(\$\{workLog\.publishedAt\}, \$\{workLog\.createdAt\}\)/)
  })

  it('запись без задачи не пропадает из списка', () => {
    // innerJoin по задаче выбросил бы большинство записей: «разбирался с
    // окружением» ни к какой задаче не привязано. Тот же промах уже был
    // допущен в инбоксе с объявлениями.
    const at = worklog.indexOf("worklogRoute.get('/'")
    const list = worklog.slice(at, worklog.indexOf("worklogRoute.get('/authors'"))
    expect(list).toMatch(/\.leftJoin\(tasks, eq\(tasks\.id, workLog\.taskId\)\)/)
  })
})
