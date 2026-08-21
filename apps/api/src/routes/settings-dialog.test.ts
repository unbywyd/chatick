import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Диалог настроек проекта открывался ПУСТЫМ.
//
// Форма наполнялась внутри queryFn, и это работало ровно до тех пор, пока
// каждое монтирование ходило на сервер. Ключ ['project', id] общий с
// ProjectScreen: открывая настройки изнутри проекта, react-query находит
// свежий ответ в кеше и queryFn НЕ ЗОВЁТ вовсе.
//
// Проявилось после того, как у запросов появился staleTime: до него каждый
// монтаж перезапрашивал, и дыра была не видна.

const appDir = join(import.meta.dirname, '../../../app/src')
const dialog = readFileSync(join(appDir, 'components/ProjectSettingsDialog.tsx'), 'utf8')

describe('настройки проекта открываются заполненными', () => {
  it('форма берётся из данных, а не из тела запроса', () => {
    // Саботаж: вернуть setForm внутрь queryFn — диалог снова опустеет там,
    // где данные уже в кеше.
    const at = dialog.indexOf('queryFn:')
    expect(at, 'запрос не найден').toBeGreaterThan(-1)
    const body = dialog.slice(at, dialog.indexOf('})', at))
    expect(body, 'setForm внутри queryFn').not.toMatch(/setForm/)
    expect(dialog).toMatch(/useEffect\(\(\) => \{[\s\S]{0,80}projectQ\.data/)
  })

  it('набранное не затирается фоновым обновлением', () => {
    // cur ?? ... : рефетч приходит, пока человек правит поля.
    expect(dialog).toMatch(/setForm\(\(cur\) =>\s*\n?\s*cur \?\?/)
  })
})

describe('та же ошибка не повторяется в других местах', () => {
  it('никто не наполняет состояние внутри queryFn', () => {
    // Общий ключ + staleTime = queryFn может не вызваться никогда. Побочные
    // эффекты там незаметно перестают работать.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.tsx') ? [join(dir, e.name)] : [],
      )
    const offenders: string[] = []
    for (const file of walk(appDir)) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/queryFn:\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g)) {
        let depth = 1
        let i = m.index! + m[0].length
        const start = i
        for (; i < src.length && depth > 0; i++) {
          if (src[i] === '{') depth++
          else if (src[i] === '}') depth--
        }
        if (/\bset[A-Z]\w*\(/.test(src.slice(start, i))) offenders.push(file.split(/[\/]/).pop()!)
      }
    }
    expect(offenders, `состояние меняется внутри queryFn: ${offenders.join(', ')}`).toEqual([])
  })
})
