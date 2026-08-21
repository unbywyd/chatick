import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Человек, заведённый внешней системой, наследует язык компании.
 *
 * Раньше срабатывало умолчание схемы — 'en'. В компании StartPlan, где все
 * проекты на иврите, это значило: ИИ пересказывал ивритские сообщения
 * по-английски, и в ленте уведомлений рядом с ивритским текстом стояла
 * английская строка.
 *
 * Проверено по базе: все 12 участников имели locale='en' при
 * locale_set_by_user=false — то есть язык не выбирал ни один из них.
 */

const ext = readFileSync(join(import.meta.dirname, 'ext.ts'), 'utf8')
const auth = readFileSync(join(import.meta.dirname, 'auth.ts'), 'utf8')

describe('язык нового человека', () => {
  it('внешняя система: наследуется от компании', () => {
    const create = ext.slice(ext.indexOf('async function upsertUser'))
    expect(create, 'язык снова берётся из умолчания схемы').toMatch(/locale: company\?\.locale \?\? 'en'/)
  })

  it('внешняя система: выбор не приписывается человеку', () => {
    /**
     * localeSetByUser остаётся false: он и правда ничего не выбирал. Поставь
     * мы true — смена языка в профиле перестала бы отличаться от
     * унаследованного значения, и починить чужую ошибку стало бы нельзя.
     */
    const create = ext.slice(ext.indexOf('async function upsertUser'), ext.indexOf('async function upsertUser') + 1500)
    expect(create).not.toMatch(/localeSetByUser: true/)
  })

  it('вход по коду: язык берут с формы, а не у компании', () => {
    // Там человек читает форму на конкретном языке — он и есть его выбор.
    expect(auth).toMatch(/localeSetByUser: typeof body\.locale === 'string'/)
  })
})
