import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Название ключа в ресурсах видно целиком.
 *
 * Метка стояла в полосе шириной 112 пикселей (w-28) с обрезкой. «Логин» туда
 * влезал, «Логин от Cardcom» — уже нет, и человек видел обрубок вместо того,
 * за чем пришёл. Ключи ресурсов для того и хранят, чтобы прочитать.
 */

const tab = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/tabs/ResourcesTab.tsx'),
  'utf8',
)

/** Разметка одной сохранённой пары «название — значение». */
const row = tab.slice(tab.indexOf('function ExistingSecret'), tab.indexOf('function AuditLog'))

describe('строка ключа в ресурсах', () => {
  it('название не зажато фиксированной шириной', () => {
    expect(row, 'название не найдено').not.toBe('')
    expect(row, 'вернулась полоса в 112 пикселей').not.toMatch(/w-28 shrink-0 truncate/)
    expect(row, 'название снова обрезается').toMatch(/break-words font-medium/)
  })

  it('раскрытое значение переносится, а не режется', () => {
    /**
     * Его показывают ровно затем, чтобы прочитать глазами. Скрытые точки при
     * этом остаются строкой — переноситься им незачем.
     */
    expect(row).toMatch(/value \? 'break-all' : 'truncate'/)
  })

  it('название копируется отдельно от значения', () => {
    // Логин нужен так же часто, как пароль, а перепечатывать его руками —
    // надёжный способ ошибиться в одном символе.
    expect(row).toMatch(/clipboard\.writeText\(label\)/)
  })

  it('кнопки не сжимаются длинным значением', () => {
    // Иначе перенос длинной строки выдавливает их за край.
    expect((row.match(/className="shrink-0"/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})

describe('ввод нового ключа', () => {
  it('на узкой панели поля идут друг под другом', () => {
    // Название и значение делили строку, и названию доставалось 128 пикселей:
    // человек не видел, что печатает.
    expect(tab).toMatch(/flex flex-wrap items-center gap-1\.5 sm:flex-nowrap/)
    expect(tab, 'поле названия снова фиксированной ширины').toMatch(/h-8 w-full text-xs sm:w-40/)
  })
})
