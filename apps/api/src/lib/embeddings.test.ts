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
    expect(lib).toMatch(/opts\.minScore \?\? 0\.25/)
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
