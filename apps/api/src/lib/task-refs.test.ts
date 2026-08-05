import { describe, it, expect } from 'vitest'
import { parseRefs, normalizeRefs } from './task-refs.js'

// Свои номера задачи: экраны в макете, пункты договора, позиции сметы.
//
// Всё правило — в одной фразе: делим ТОЛЬКО по запятой. Соблазн разобрать
// «4 - 3» на два номера велик, но у одних это диапазон экранов, а у других
// составной шифр, и решать за них нельзя.

describe('разбор', () => {
  it('делим по запятой, а не по пробелам', () => {
    expect(parseRefs('12.3, 4 - 3, 5')).toEqual(['12.3', '4 - 3', '5'])
  })

  it('«12 - 12» — один номер, а не два', () => {
    expect(parseRefs('12 - 12')).toEqual(['12 - 12'])
  })

  it('пробелы срезаем только по краям — внутри они часть номера', () => {
    expect(parseRefs('  7 ,  8 - 9  ')).toEqual(['7', '8 - 9'])
  })

  it('пустые куски выпадают: лишняя запятая не даёт пустого чипа', () => {
    expect(parseRefs('1,,2,')).toEqual(['1', '2'])
    expect(parseRefs('')).toEqual([])
    expect(parseRefs('   ')).toEqual([])
  })

  it('буквы и знаки не проходят — поле для номеров', () => {
    expect(parseRefs('12<script>, 8')).toEqual(['12', '8'])
    expect(parseRefs('экран 5')).toEqual(['5'])
  })

  it('точки и дефисы остаются', () => {
    expect(parseRefs('1.2.3, 4-5')).toEqual(['1.2.3', '4-5'])
  })
})

describe('приведение к виду хранения', () => {
  it('«1,2» и «1, 2» ложатся в базу одинаково', () => {
    // Иначе поиск по номеру находил бы то одну запись, то другую.
    expect(normalizeRefs('1,2')).toBe(normalizeRefs('1, 2'))
    expect(normalizeRefs('1,2')).toBe('1, 2')
  })

  it('пустая строка остаётся пустой, а не превращается в запятую', () => {
    expect(normalizeRefs('')).toBe('')
    expect(normalizeRefs(' , , ')).toBe('')
  })

  it('длина ограничена — поле для номеров, а не для описания', () => {
    expect(normalizeRefs('1, '.repeat(500)).length).toBeLessThanOrEqual(200)
  })
})
