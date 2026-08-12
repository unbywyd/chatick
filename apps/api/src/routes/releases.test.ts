import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUILD_TYPES, buildType, firstStage, isLiveStage, isValidStage } from '../lib/release-stages.js'

// Версии проекта.
//
// Здесь проверяются два условия, нарушить которые легче всего незаметно:
// функция выключена — ручка закрыта, и стадия не меняется без объяснения.
// Оба существуют не ради строгости: первое отделяет проекты, которым релизы
// не нужны, второе спасает ответ на вопрос «почему версия неделю висит в ревью».

const src = readFileSync(join(import.meta.dirname, 'releases.ts'), 'utf8')

describe('лестницы стадий', () => {
  it('у каждого типа сборки есть конечная стадия', () => {
    // Без неё сводка «что сейчас в проде» не соберётся: система не знает,
    // какая стадия означает «доехало до людей».
    for (const t of BUILD_TYPES) {
      expect(t.stages.some((s) => s.live), `у ${t.key} нет конечной стадии`).toBe(true)
    }
  })

  it('ключи стадий внутри типа не повторяются', () => {
    for (const t of BUILD_TYPES) {
      const keys = t.stages.map((s) => s.key)
      expect(new Set(keys).size, `дубли стадий в ${t.key}`).toBe(keys.length)
    }
  })

  it('у iOS ревью Apple отделено от публикации', () => {
    // Слив их в одну стадию убивает главный сценарий: «висим в ревью» и
    // «вышли» — разные ответы на «что с версией».
    const ios = buildType('ios')!.stages.map((s) => s.key)
    expect(ios).toContain('in_review')
    expect(ios).toContain('released')
    expect(ios.indexOf('in_review')).toBeLessThan(ios.indexOf('released'))
  })

  it('чужая стадия к типу не подходит', () => {
    expect(isValidStage('ios', 'testflight')).toBe(true)
    // testflight — не про Android; иначе сводка смешает платформы
    expect(isValidStage('android', 'testflight')).toBe(false)
    expect(isValidStage('nope', 'building')).toBe(false)
  })

  it('первая стадия есть у всех типов', () => {
    for (const t of BUILD_TYPES) expect(firstStage(t.key)).toBeTruthy()
  })

  it('конечная стадия распознаётся, промежуточная — нет', () => {
    expect(isLiveStage('ios', 'released')).toBe(true)
    expect(isLiveStage('ios', 'testflight')).toBe(false)
  })
})

describe('ручки версий', () => {
  it('каждая ручка проходит через общую проверку', () => {
    // Забытая проверка в одной ручке открывает чужие релизы, и по коду самой
    // ручки этого не видно — потому проверка одна на всех.
    const handlers = src.match(/releasesRoute\.(get|post|patch|delete)\(/g) ?? []
    const guards = src.match(/await guard\(/g) ?? []
    expect(handlers.length).toBeGreaterThan(0)
    expect(guards.length).toBe(handlers.length)
  })

  it('выключенная функция закрывает ручку', () => {
    expect(src).toMatch(/isFeatureEnabled\([^)]*'releases'\)/)
  })

  it('чтение и правка разведены по разным правам', () => {
    expect(src).toMatch(/'releases\.read'/)
    expect(src).toMatch(/'releases\.manage'/)
  })

  it('комментарий к смене стадии обязателен', () => {
    // min(1) — не косметика: пустой переход не объясняет ничего, а спросить
    // задним числом уже не у кого.
    const stage = src.slice(src.indexOf('const stageSchema'))
    expect(stage).toMatch(/comment: z\.string\(\)\.min\(1\)/)
  })

  it('удалить можно связь, но не саму версию', () => {
    // Версия — факт: она была собрана и куда-то уехала. Связь с задачей —
    // всего лишь связь, её снятие ничего не стирает.
    const deletes = src.match(/releasesRoute\.delete\('([^']+)'/g) ?? []
    expect(deletes.length).toBeGreaterThan(0)
    for (const d of deletes) {
      expect(d, `удаление ${d} затрагивает саму версию`).toMatch(/\/tasks\//)
    }
  })

  it('дата выката не переписывается повторным выходом', () => {
    expect(src).toMatch(/!existing\.releasedAt/)
  })
})
