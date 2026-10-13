import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Предохранитель от клиентских веток в нашем коде.
 *
 * Для клиентов бывают свои копии с их брендом и настройками — например,
 * ветка `startplan` (tasks.startplan.net): их логотип и имя вместо Chatick,
 * сборка под Heroku, свой MCP. Такая ветка живёт отдельно и в master/v2 не
 * вливается. Если её всё-таки сольют сюда, эти проверки упадут — до выкатки
 * чужого бренда на chatick.com.
 */
const root = join(import.meta.dirname, '../../../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('наш код — с нашим брендом', () => {
  it('приложение называется Chatick', () => {
    expect(read('apps/app/index.html')).toContain('<title>Chatick</title>')
    expect(read('apps/app/src/i18n/locales/en.json')).toContain('"name": "Chatick"')
  })

  it('письма уходят от Chatick, MCP называется chatick', () => {
    expect(read('apps/api/src/lib/mail.ts')).toContain("env.SMTP_FROM_NAME || 'Chatick'")
    expect(read('apps/mcp/src/tools.ts')).toContain("new McpServer({ name: 'chatick'")
  })

  it('файлов клиентских копий здесь нет', () => {
    for (const p of [
      'apps/app/public/brand/startplan-on-light.svg',
      'apps/app/public/brand/startplan-on-dark.svg',
      'apps/app/public/mcp/startplan-mcp.mjs',
      'heroku.yml',
      'Dockerfile',
    ]) {
      expect(existsSync(join(root, p)), p).toBe(false)
    }
  })
})
