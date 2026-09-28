import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Уведомление о смене статуса называет статус словами получателя.
 *
 * На проде лежали ивритские уведомления вида «שונה ל-«in_progress»»: в текст
 * подставлялся сырой ключ. На доске тот же статус назывался «בתהליך».
 */

const notify = readFileSync(join(import.meta.dirname, 'notify.ts'), 'utf8').replace(/\r\n/g, '\n')
const status = readFileSync(join(import.meta.dirname, 'task-status.ts'), 'utf8').replace(/\r\n/g, '\n')
const loc = (l: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${l}.json`), 'utf8')) as {
    tasks: { status: Record<string, string> }
  }

/** Разбираем карту STATUS_WORDS из исходника: по языку — объект ключ → слово. */
function wordsFor(lang: string): Record<string, string> {
  const m = notify.match(new RegExp(`^  ${lang}: \\{([^}]*)\\},?$`, 'm'))
  if (!m) throw new Error(`в STATUS_WORDS нет языка ${lang}`)
  const out: Record<string, string> = {}
  for (const pair of m[1]!.split(',')) {
    const kv = pair.match(/^\s*(\w+):\s*'([^']*)'\s*$/)
    if (kv) out[kv[1]!] = kv[2]!
  }
  return out
}

describe('статус в уведомлении — словами, не ключом', () => {
  it('подстановка стоит там же, где срок превращается в слова', () => {
    // Оба пути — правка из интерфейса и ассистент чата — проходят через
    // notify(), поэтому правка одна, и стоять она обязана до tr().
    //
    // Саботаж: убрать строку — тест падает.
    expect(notify).toContain('if (vars.status) vars.status = statusWords(vars.status, lang)')
    expect(notify.indexOf('vars.status = statusWords('), 'подстановка после сборки текста').toBeLessThan(notify.indexOf('title: tr(lang, event, vars)'))
  })

  it('слова совпадают с доской на каждом языке', () => {
    // Уведомление и доска обязаны называть статус одинаково — иначе человек
    // ищет на доске колонку, которой нет.
    //
    // Саботаж: поменять одно слово в STATUS_WORDS — тест называет язык и статус.
    const line = status.split('\n').find((l) => l.includes('TASK_STATUSES = [')) ?? ''
    const keys = [...line.matchAll(/'(\w+)'/g)].map((m) => m[1]!)
    expect(keys.length, 'список статусов не прочитан').toBeGreaterThanOrEqual(6)
    for (const lang of ['en', 'ru', 'he']) {
      const words = wordsFor(lang)
      const ui = loc(lang).tasks.status
      for (const k of keys) {
        expect(words[k], `${lang}: в уведомлении нет слова для ${k}`).toBeTruthy()
        expect(words[k], `${lang}: уведомление и доска называют ${k} по-разному`).toBe(ui[k])
      }
    }
  })

  it('неизвестный ключ не превращается в пустоту', () => {
    expect(notify).toContain('?? STATUS_WORDS.en[status] ?? status')
  })
})
