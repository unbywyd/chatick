import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentHash } from './embeddings.js'

/**
 * Поиск по смыслу.
 *
 * Человек спрашивает «не приходит смс», а записано «SMS с кодом не
 * доставляется» — один вопрос и ни одного общего слова. Для иврита это не
 * удобство, а единственный путь: словаря иврита в Postgres нет вовсе, и
 * полнотекстовый поиск дал бы ему точное совпадение слова, без форм.
 *
 * Две опасности, и обе тихие. Первая — запись, не попавшая в индекс: она есть,
 * а поиском не находится, и узнать об этом можно только не найдя её однажды.
 * Вторая — утечка через границу компании: поиск, забывший фильтр, покажет
 * чужие заметки, и никакой ошибки при этом не будет.
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8')
const lib = read('embeddings.ts')

describe('индексируются ВСЕ пути записи', () => {
  // Путей четыре: интерфейс создаёт и правит, мост правит, ассистент правит.
  // Забыть один — значит потерять часть записей молча.
  it('создание — через общую createNote, значит покрыто разом', () => {
    const notes = read('../routes/notes.ts')
    expect(notes).toMatch(/void enqueue\('note', row!\.id, projectId\)/)
    // Создание идёт через createNote и в мосту, и у ассистента — отдельных
    // insert(notes) там нет, и это стоит проверить: появится — потеряется.
    const bridge = read('../routes/bridge.ts')
    const memory = read('./memory.js'.replace('.js', '.ts'))
    expect(bridge).not.toMatch(/\.insert\(notes\)/)
    expect(memory).not.toMatch(/\.insert\(notes\)/)
  })

  it('правка из интерфейса', () => {
    const notes = read('../routes/notes.ts')
    const at = notes.indexOf('.update(notes).set(patch)')
    expect(at, 'правки не найдено').toBeGreaterThan(-1)
    // Окно до конца ручки, а не фиксированное: enqueue стоит после
    // logActivity и broadcast, и короткий срез до него не достаёт.
    const end = notes.indexOf('return c.json(serialize(row!))', at)
    expect(end, 'конец ручки не найден').toBeGreaterThan(at)
    expect(notes.slice(at, end)).toMatch(/enqueue\('note'/)
  })

  it('правка через мост', () => {
    const bridge = read('../routes/bridge.ts')
    const at = bridge.indexOf('.update(notes).set(patch)')
    expect(at, 'правки не найдено').toBeGreaterThan(-1)
    expect(bridge.slice(at, at + 400)).toMatch(/enqueueEmbedding\('note'/)
  })

  it('правка ассистентом', () => {
    const memory = read('./memory.ts')
    const at = memory.indexOf('.update(notes).set(patch)')
    expect(at, 'правки не найдено').toBeGreaterThan(-1)
    expect(memory.slice(at, at + 400)).toMatch(/enqueueEmbedding\('note'/)
  })
})

describe('индексация не мешает сохранению', () => {
  it('вектор считается фоном, а не в запросе', () => {
    // Обращение к модели занимает сотни миллисекунд. Считать его в запросе
    // значит заставить человека ждать, а при недоступной модели — не дать
    // сохранить заметку вовсе.
    const notes = read('../routes/notes.ts')
    expect(notes).toMatch(/void enqueue\(/)
    expect(notes).not.toMatch(/await enqueue\(/)
  })

  it('сбой очереди не роняет сохранение', () => {
    expect(lib).toMatch(/catch \(err\) \{\s*console\.warn\('\[embeddings\] не удалось поставить в очередь/)
  })

  it('повторная правка не плодит заданий', () => {
    // Человек правит заметку пять раз подряд — пересчитать надо один раз,
    // последнюю версию.
    expect(lib).toMatch(/\.onConflictDoUpdate\(\{[\s\S]*?target: \[embeddingQueue\.entityType, embeddingQueue\.entityId\]/)
  })
})

describe('деньги не тратятся зря', () => {
  it('текст не изменился — вектор не пересчитывается', () => {
    // Заметку правят по мелочи: тегами, статусом, напоминанием. Платить за
    // пересчёт того же текста незачем.
    expect(lib).toMatch(/existing\?\.contentHash === hash && existing\.model === MODEL/)
  })

  it('отпечаток устойчив и различает разное', () => {
    expect(contentHash('текст')).toBe(contentHash('текст'))
    expect(contentHash('текст')).not.toBe(contentHash('текст '))
  })

  it('после нескольких неудач перестаём долбиться в модель', () => {
    // Модель может отвечать отказом неделями (лимит, кончились деньги).
    expect(lib).toMatch(/lt\(embeddingQueue\.attempts, MAX_ATTEMPTS\)/)
  })

  it('пачкой, а не по одной', () => {
    // Один вызов на пятьдесят записей дешевле и быстрее пятидесяти вызовов.
    expect(lib).toMatch(/export async function flushQueue\(limit = 50\)/)
  })

  it('траты попадают в общий журнал', () => {
    // Иначе порог с письмом их не увидит, и счёт вырастет молча.
    expect(lib).toMatch(/feature: 'embedding'/)
    expect(lib).toMatch(/logAiUsage\(/)
  })
})

describe('компания — жёсткая граница поиска', () => {
  it('фильтр стоит В ЗАПРОСЕ, а не после выборки', () => {
    // Саботаж: убрать eq(embeddings.companyId, ...) — и поиск начнёт возвращать
    // чужие заметки. Ошибки при этом не будет никакой.
    //
    // Ищем строку НЕ закомментированной: первая версия этой проверки смотрела
    // просто на вхождение текста, и закомментированный фильтр её устраивал —
    // саботаж прошёл незамеченным.
    const at = lib.indexOf('export async function searchSemantic')
    const fn = lib.slice(at)
    const line = fn.split('\n').find((l) => l.includes('eq(embeddings.companyId, opts.companyId)'))
    expect(line, 'фильтр по компании исчез из поиска').toBeTruthy()
    expect(line!.trimStart().startsWith('//'), 'фильтр по компании закомментирован').toBe(false)
  })

  it('есть порог отсечения', () => {
    // Без него запрос всегда вернёт limit записей, даже когда подходящих нет
    // вовсе, — и ассистент примет самое похожее из мусора за ответ.
    expect(lib).toMatch(/opts\.minScore \?\? 0\.32/)
  })
})

describe('без ключа поиск выключен, а не сломан', () => {
  it('проверка ключа стоит на входе каждой ручки', () => {
    for (const fn of ['enqueue', 'flushQueue', 'searchSemantic', 'backfill']) {
      const at = lib.indexOf(`export async function ${fn}`)
      expect(at, `${fn} не найдена`).toBeGreaterThan(-1)
      expect(lib.slice(at, at + 600), `${fn} не проверяет ключ`).toMatch(/embeddingsEnabled\(\)/)
    }
  })
})

describe('поиск по смыслу доступен обоим ассистентам', () => {
  // Ассистент снаружи ходит через мост, ассистент внутри Chatick — через
  // свои инструменты. Разные пути, один вопрос: ответы обязаны совпадать.
  it('мост и внутренний ассистент зовут ОДНУ функцию', () => {
    const bridge = read('../routes/bridge.ts')
    const memory = read('./memory.ts')
    expect(bridge, 'мост не ищет по смыслу').toMatch(/searchNoteIds\(\{/)
    expect(memory, 'внутренний ассистент не ищет по смыслу').toMatch(/searchNoteIds\(\{/)
  })

  it('обоим сказано, что поиск понимает смысл', () => {
    // Модель не станет спрашивать своими словами, если думает, что ищется
    // подстрока: она будет угадывать точную формулировку.
    const bridge = read('../routes/bridge.ts')
    const memory = read('./memory.ts')
    for (const [src, who] of [[bridge, 'мост'], [memory, 'ассистент']] as const) {
      expect(src, `${who} не объясняет про смысл`).toMatch(/understands MEANING/)
    }
  })
})

describe('пустой результат честен', () => {
  // Прежний ilike при отсутствии совпадений просто НЕ ДОБАВЛЯЛ условия — и
  // «поиск» возвращал весь журнал. Ассистент принимал это за найденное и
  // отвечал по случайной заметке.
  it('мост отсекает выдачу, когда не нашлось ничего', () => {
    const bridge = read('../routes/bridge.ts')
    const at = bridge.indexOf('const hybrid = await searchNoteIds({')
    expect(at, 'гибридный поиск в мосту не найден').toBeGreaterThan(-1)
    expect(bridge.slice(at, at + 900)).toMatch(/conds\.push\(sql`false`\)/)
  })

  it('внутренний ассистент отвечает «не найдено», а не всем журналом', () => {
    const memory = read('./memory.ts')
    const at = memory.indexOf('const hybrid = await searchNoteIds({')
    expect(at, 'гибридный поиск у ассистента не найден').toBeGreaterThan(-1)
    expect(memory.slice(at, at + 900)).toMatch(/if \(!hybrid\.ids\.length\) return 'No notes found\.'/)
  })
})

describe('гибрид: слова и смысл вместе', () => {
  it('точные совпадения ищутся по-прежнему', () => {
    // «Cardcom» надёжнее найти дословно, чем через модель. Смысл дополняет
    // слова, а не заменяет их.
    const at = lib.indexOf('export async function searchNoteIds')
    const fn = lib.slice(at)
    expect(fn).toMatch(/ilike \$\{like\}/)
    expect(fn).toMatch(/searchSemantic\(\{/)
  })

  it('точные идут первыми, смысловые следом', () => {
    const at = lib.indexOf('export async function searchNoteIds')
    const fn = lib.slice(at)
    expect(fn).toMatch(/return \{ ids: \[\.\.\.ids, \.\.\.semanticIds\], semanticIds \}/)
  })

  it('падение модели не роняет поиск целиком', () => {
    // Неполный поиск лучше упавшего: слова всё равно нашлись.
    const at = lib.indexOf('export async function searchNoteIds')
    expect(lib.slice(at)).toMatch(/смысловой поиск не сработал/)
  })

  it('чужой проект не просачивается через вектор', () => {
    // Вектор ограничен компанией, а видимость — проектом: без этой проверки
    // проектная заметка чужого проекта попала бы в выдачу.
    const at = lib.indexOf('export async function searchNoteIds')
    expect(lib.slice(at)).toMatch(/if \(!opts\.companyWide && r\.projectId !== opts\.projectId\) continue/)
  })
})

describe('массивы в SQL передаются так, как их понимает драйвер', () => {
  it('фильтр по типам — через inArray, а не sql`= any(...)`', () => {
    // Ровно на этом поиск заметок падал НА КАЖДОМ запросе: drizzle
    // разворачивает массив в отдельные параметры, и any() получал строку.
    //
    // Наружу это выглядело как «ничего не найдено»: ошибку глушил catch,
    // поставленный на случай недоступной модели. Типы такого не ловят, а
    // тесты на границы проходили — ошибка живёт в самом SQL.
    const at = lib.indexOf('export async function searchSemantic')
    const fn = lib.slice(at)
    expect(fn, 'снова sql`= any(...)` — запрос упадёт на живых данных').not.toMatch(/= any\(\$\{types\}\)/)
    expect(fn).toMatch(/inArray\(embeddings\.entityType, types\)/)
  })

  it('и в поиске задач тоже', () => {
    const at = lib.indexOf('export async function searchTaskIds')
    const fn = lib.slice(at)
    expect(fn).toMatch(/inArray\(embeddings\.projectId, allowedIds\)/)
    expect(fn).not.toMatch(/= any\(/)
  })
})
