import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { asksToLook, MAX_IMAGES, MAX_BYTES, SUPPORTED } from './vision.js'

// Картинки для модели.
//
// Главное здесь — что решение принимает СЕРВЕР, а не промпт. Просить модель
// «не смотри, пока не попросят» бесполезно: изображение, уехавшее в запрос,
// уже увидено и уже оплачено. Правило, которое нельзя нарушить, лучше правила,
// о котором просят.

const lib = readFileSync(join(import.meta.dirname, 'vision.ts'), 'utf8')
const route = readFileSync(join(import.meta.dirname, '../routes/messages.ts'), 'utf8')
const disp = readFileSync(join(import.meta.dirname, 'dispatcher.ts'), 'utf8')

describe('картинка уходит только по просьбе', () => {
  it('просьбу узнаёт на трёх языках', () => {
    for (const t of ['посмотри что тут', 'глянь скрин', 'что на картинке?', 'look at this screenshot', 'תסתכל על התמונה'])
      expect(asksToLook(t), t).toBe(true)
  })

  it('одно вложение без слов — это и есть «смотри»', () => {
    // Человек прикладывает скриншот и ничего не пишет: и так понятно. Требовать
    // от него ещё и слов — значит заставлять угадывать заклинание.
    expect(asksToLook('📎')).toBe(true)
    expect(asksToLook('')).toBe(true)
  })

  it('картинка и просьба могут быть РАЗНЫМИ сообщениями', () => {
    // Так люди и делают: сначала «📎», следом «посмотри». Ищем вложения и в
    // предыдущем своём сообщении — но только в соседнем, чтобы «глянь» через
    // час не подтянуло забытый скриншот.
    const fn = lib.slice(lib.indexOf('export async function imagesForMessage'))
    // Граница по ВРЕМЕНИ, а не по числу реплик: между «вот скрин» и «глянь»
    // человек напишет то одну, то пять — любое N окажется неверным.
    expect(fn).toMatch(/gte\(files\.createdAt, since\)/)
    expect(fn).toMatch(/eq\(messages\.authorId, userId\)/)
    expect(lib).toMatch(/const RECENT_WINDOW_MS = \d+ \* 60 \* 1000/)
  })

  it('обычное сообщение картинку не тянет', () => {
    // Иначе каждый скриншот в переписке оплачивался бы просто за то, что он
    // приложен.
    for (const t of ['вот держи', 'ок, спасибо', 'создай задачу по этому', 'сколько задач в спринте?'])
      expect(asksToLook(t), t).toBe(false)
  })

  it('без просьбы функция выходит СРАЗУ, не читая файлы', () => {
    // Не «прочитали и не отправили»: лишний поход в хранилище на каждое
    // сообщение чата — это заметно.
    const fn = lib.slice(lib.indexOf('export async function imagesForMessage'))
    const guard = fn.indexOf('if (!asksToLook(text)) return []')
    const read = fn.indexOf('getObjectStream')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(read)
  })
})

describe('выключатель у компании', () => {
  it('вижен выключен по умолчанию', () => {
    // Модель, которая не умеет смотреть картинки, отвечает ошибкой на ВЕСЬ
    // запрос: человек получит «не получилось» вместо ответа.
    const schema = readFileSync(join(import.meta.dirname, '../db/schema.ts'), 'utf8')
    expect(schema).toMatch(/llmVision: boolean\('llm_vision'\)\.notNull\(\)\.default\(false\)/)
  })

  it('выключен — картинки не читаются вовсе', () => {
    const fn = lib.slice(lib.indexOf('export async function imagesForMessage'))
    expect(fn).toMatch(/if \(!company\?\.vision\) return \[\]/)
    expect(fn.indexOf('company?.vision')).toBeLessThan(fn.indexOf('getObjectStream'))
  })

  it('модель знает, ГДЕ его включить', () => {
    // Иначе человек видит «не могу смотреть» и идёт искать причину сам.
    expect(disp).toMatch(/Company settings . AI/)
    expect(disp).toMatch(/TURNED OFF for this company/)
  })
})

describe('файлы ассистента временные', () => {
  it('в ai-режиме флаг временности НЕ снимается', () => {
    // Иначе каждый показанный скриншот навсегда оседает в файлах проекта.
    expect(route).toMatch(/\.\.\.\(mode === 'ai' \? \{\} : \{ pendingUntil: null \}\)/)
  })

  it('сохранение — отдельное решение человека', () => {
    const mem = readFileSync(join(import.meta.dirname, 'memory.ts'), 'utf8')
    expect(mem).toMatch(/keep_attached_file/)
    expect(mem).toMatch(/discard_attached_file/)
    // Ассистент не сохраняет молча: большинство скриншотов показывают один раз.
    expect(mem).toMatch(/Do not save on your own/)
  })
})

describe('потолки', () => {
  it('картинок за раз немного', () => {
    // Десяток скриншотов в одном вопросе — это не вопрос.
    expect(MAX_IMAGES).toBeGreaterThan(0)
    expect(MAX_IMAGES).toBeLessThanOrEqual(6)
  })

  it('размер ограничен', () => {
    expect(MAX_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024)
  })

  it('форматы только те, что модели понимают', () => {
    expect(SUPPORTED.has('image/png')).toBe(true)
    expect(SUPPORTED.has('image/jpeg')).toBe(true)
    // svg — это разметка, а не растр: модели её не видят, а мы бы отправили.
    expect(SUPPORTED.has('image/svg+xml')).toBe(false)
    expect(SUPPORTED.has('application/pdf')).toBe(false)
  })
})

describe('только личный диалог с ассистентом', () => {
  it('картинки берутся в ai-ветке, а не в общем чате', () => {
    // В общем чате картинки летят постоянно и не ассистенту.
    const ai = route.slice(route.indexOf("if (mode === 'ai')"))
    expect(ai.slice(0, 1500)).toMatch(/imagesForMessage/)
    // Считаем ВЫЗОВЫ, а не упоминания: импорт стоит в начале файла и в
    // «общую» часть попадал бы всегда.
    expect((route.match(/await imagesForMessage\(/g) ?? []).length).toBe(1)
  })

  it('вложения привязаны к сообщению ДО вызова модели', () => {
    // Иначе imagesForMessage не найдёт ничего: файлы ещё ничьи.
    expect(route.indexOf('.set({ messageId: row!.id')).toBeLessThan(route.indexOf('await imagesForMessage('))
  })
})

describe('модель предупреждена', () => {
  it('когда картинок нет — объясняет почему, а не делает вид', () => {
    // Худший исход: модель отвечает про картинку, которой не видела.
    expect(disp).toMatch(/do not pretend you saw it/)
    expect(disp).toMatch(/ask explicitly/)
  })

  it('когда есть — не додумывает нечитаемое', () => {
    expect(disp).toMatch(/do not guess at what you cannot make out/)
  })
})

describe('формат для провайдеров', () => {
  const llm = readFileSync(join(import.meta.dirname, 'llm.ts'), 'utf8')

  it('anthropic: base64-источник, картинки перед текстом', () => {
    expect(llm).toMatch(/type: 'base64', media_type: im\.mediaType/)
    const block = llm.slice(llm.indexOf('const userContent'), llm.indexOf("const msgs: unknown[] = [{ role: 'user', content: userContent }]"))
    expect(block.indexOf("type: 'image'")).toBeLessThan(block.indexOf("type: 'text'"))
  })

  it('openai-совместимые: data-URI', () => {
    expect(llm).toMatch(/image_url: \{ url: `data:\$\{im\.mediaType\};base64,\$\{im\.base64\}` \}/)
  })
})
