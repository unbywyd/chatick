import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { S3Client, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { parseMoved } from './moved-companies.js'
import { keepObjectsWhen } from './s3.js'

describe('компании, которые переехали', () => {
  it('читает список и адрес из настройки площадки', () => {
    const m = parseMoved('{"c1":{"url":"https://tasks.startplan.net"},"c2":{}}')
    expect(m.get('c1')).toEqual({ url: 'https://tasks.startplan.net', deleteAt: null })
    expect(m.get('c2')).toEqual({ url: null, deleteAt: null })
    expect(m.has('c3')).toBe(false)
  })

  it('кривое значение — никто не переехал, список компаний не падает', () => {
    expect(parseMoved('').size).toBe(0)
    expect(parseMoved('not json').size).toBe(0)
    expect(parseMoved('["c1"]').size).toBe(0)
  })

  it('в ссылку баннера идёт только http(s)', () => {
    expect(parseMoved('{"c1":{"url":"javascript:alert(1)"}}').get('c1')).toEqual({ url: null, deleteAt: null })
  })

  it('дата удаления витрины — только настоящая дата', () => {
    expect(parseMoved('{"c1":{"deleteAt":"2026-10-16"}}').get('c1')?.deleteAt).toBe('2026-10-16')
    expect(parseMoved('{"c1":{"deleteAt":"скоро"}}').get('c1')?.deleteAt).toBeNull()
    expect(parseMoved('{"c1":{"deleteAt":3}}').get('c1')?.deleteAt).toBeNull()
  })

  it('список компаний отдаёт признак moved', () => {
    const src = readFileSync(join(import.meta.dirname, '../routes/companies.ts'), 'utf8')
    const at = src.indexOf("companiesRoute.get('/'")
    expect(src.slice(at, at + 2600)).toMatch(/moved: moved\.get\(m\.company\.id\) \?\? null/)
  })

  describe('хранилище переехавшей компании — только на чтение', () => {
    // Бакет общий с их копией: удаление у нас стёрло бы их файл.
    function client(moved: () => Promise<boolean>) {
      const c = new S3Client({ region: 'auto', endpoint: 'http://127.0.0.1:9', credentials: { accessKeyId: 'a', secretAccessKey: 'b' } })
      keepObjectsWhen(c, moved)
      const reached: string[] = []
      // Шпион вместо сети: до него доходит то, что ушло бы в бакет.
      c.middlewareStack.add(
        (_next, ctx) => async () => {
          reached.push(ctx.commandName ?? '?')
          return { output: { $metadata: {} }, response: {} } as never
        },
        { step: 'build', name: 'spy' },
      )
      return { c, reached }
    }

    it('удаления не уходят в бакет, чтение уходит', async () => {
      const { c, reached } = client(async () => true)
      await c.send(new DeleteObjectCommand({ Bucket: 'b', Key: 'k' }))
      await c.send(new DeleteObjectsCommand({ Bucket: 'b', Delete: { Objects: [{ Key: 'k' }] } }))
      await c.send(new GetObjectCommand({ Bucket: 'b', Key: 'k' }))
      expect(reached).toEqual(['GetObjectCommand'])
    })

    it('не переехала — удаляет как обычно', async () => {
      const { c, reached } = client(async () => false)
      await c.send(new DeleteObjectCommand({ Bucket: 'b', Key: 'k' }))
      expect(reached).toEqual(['DeleteObjectCommand'])
    })

    it('не знаем, переехала ли, — не удаляем', async () => {
      const { c, reached } = client(async () => {
        throw new Error('db down')
      })
      await c.send(new DeleteObjectCommand({ Bucket: 'b', Key: 'k' }))
      expect(reached).toEqual([])
    })

    it('каждый клиент своего хранилища — с защитой', () => {
      const src = readFileSync(join(import.meta.dirname, 's3.ts'), 'utf8')
      // Один — платформенный, второй — в customClient; новый обход защиты сюда не пройдёт.
      expect(src.match(/new S3Client\(/g)).toHaveLength(2)
      expect(src).toMatch(/return keepObjectsWhen\(client, async \(\) => \(await movedCompaniesCached\(\)\)\.has\(companyId\)\)/)
    })
  })

  it('сводка, напоминания и автобэкап обходят переехавших', () => {
    const read = (f: string) => readFileSync(join(import.meta.dirname, f), 'utf8')
    expect(read('digest.ts')).toMatch(/const live = items\.filter\(\(it\) => !moved\.has\(it\.project\.companyId\)\)/)
    expect(read('reminders.ts')).toMatch(/\(await movedCompaniesCached\(\)\)\.has\(project\.companyId\)/)
    expect(read('auto-backup.ts')).toMatch(/moved\.has\(c\.id\)\) continue/)
  })
})
