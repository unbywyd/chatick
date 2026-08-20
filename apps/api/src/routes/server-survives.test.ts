import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Сервер переживает обрыв связи с базой.
//
// База живёт на другой машине, и ECONNRESET там — обычное дело. Node убивает
// процесс на необработанном отклонении, а рассылка присутствия зовётся без
// await. Одного обрыва хватало, чтобы API умер: приложение оставалось открытым
// и залогиненным, но списки проектов пустели и пропадал пользователь —
// отвечать было некому. Помогал только перезапуск.
//
// Проверено на живом Node: без защиты процесс падает, с защитой — пишет в лог
// и продолжает работать.

const ws = readFileSync(join(import.meta.dirname, '../ws.ts'), 'utf8')
const server = readFileSync(join(import.meta.dirname, '../server.ts'), 'utf8')

describe('фоновая рассылка не роняет процесс', () => {
  it('присутствие рассылается под защитой', () => {
    // Саботаж: убрать try — падение вернётся, потому что зовут через void.
    const at = ws.indexOf('async function pushPresence')
    expect(at, 'pushPresence не найдена').toBeGreaterThan(-1)
    const body = ws.slice(at, at + 400)
    expect(body).toMatch(/try \{/)
    expect(body).toMatch(/catch/)
  })

  it('присутствие в документе — тоже', () => {
    const at = ws.indexOf('async function pushDocPresence')
    expect(at).toBeGreaterThan(-1)
    const body = ws.slice(at, at + 400)
    expect(body).toMatch(/try \{/)
    expect(body).toMatch(/catch/)
  })

  it('отказ не молчит', () => {
    // Проглоченная молча ошибка становится невидимой, и следующий такой же
    // случай будет искать уже некому.
    const at = ws.indexOf('async function pushPresence')
    expect(ws.slice(at, at + 400)).toMatch(/console\.error/)
  })
})

describe('общая страховка на весь процесс', () => {
  it('необработанное отклонение не убивает сервер', () => {
    // Рассылка присутствия — не единственная фоновая задача: почта, веб-хуки,
    // напоминания зовутся так же. Точечных try мало.
    expect(server).toMatch(/process\.on\('unhandledRejection'/)
  })

  it('и оно попадает в лог', () => {
    const at = server.indexOf("process.on('unhandledRejection'")
    expect(server.slice(at, at + 200)).toMatch(/console\.error/)
  })
})
