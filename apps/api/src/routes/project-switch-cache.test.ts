import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Переключение проекта не сносит общие данные.
 *
 * Раньше при входе в проект вызывался qc.clear() — сносился ВЕСЬ кэш. Шапка
 * сайдбара (название компании и переключатель) живёт на ['companies'] и от
 * проекта не зависит, но пустела при каждом переходе: компания не менялась, а
 * контрол мигал и прыгал. Стоявший там staleTime против clear() бессилен — тот
 * удаляет запись целиком, а не помечает устаревшей.
 */

const app = (f: string) => readFileSync(join(import.meta.dirname, '../../../app/src', f), 'utf8')
const hook = app('hooks/useProjectToken.ts')
const menu = app('components/ProfileMenu.tsx')

describe('кэш при смене проекта', () => {
  it('вход в проект больше не сносит кэш целиком', () => {
    const enter = hook.match(/const enter = async[\s\S]*?\n  \}/)?.[0] ?? ''
    expect(enter, 'функция входа не найдена').not.toBe('')
    expect(enter, 'снова сносится весь кэш').not.toMatch(/qc\.clear\(\)/)
    expect(enter).toMatch(/dropProjectCache\(qc\)/)
  })

  it('общее переживает переключение', () => {
    // Ищем в САМОМ списке, а не по файлу: эти имена есть и в комментариях
    // рядом, и проверка по всему тексту проходила бы с пустым списком.
    const list = hook.match(/const SESSION_KEYS = new Set\(\[[\s\S]*?\]\)/)?.[0] ?? ''
    expect(list, 'белый список не найден').not.toBe('')
    // Шапка сайдбара — на ['companies']; профиль — на ['me'].
    for (const k of ['companies', 'me']) expect(list, `${k} снова вытирается`).toMatch(new RegExp(`'${k}'`))
  })

  it('сомнительное считается проектным, а не общим', () => {
    /**
     * Белый список, а не чёрный: забыть проектный ключ в чёрном списке значит
     * показать чужие данные, забыть общий в белом — сделать лишний запрос.
     * Ошибаться безопаснее во вторую сторону.
     */
    expect(hook).toMatch(/!SESSION_KEYS\.has\(head\)/)
    // Ключ не строка — тоже проектный: под неизвестное подстраиваться нельзя.
    expect(hook).toMatch(/typeof head !== 'string' \|\|/)
  })

  it('notify-config не попал в общие: он проектный', () => {
    // Выглядит общим, но ключ ['notify-config', projectId] и project-токен.
    const list = hook.match(/const SESSION_KEYS = new Set\(\[[\s\S]*?\]\)/)?.[0] ?? ''
    expect(list, 'белый список не найден').not.toBe('')
    expect(list).not.toMatch(/notify-config/)
  })

  it('при выходе кэш по-прежнему сносится целиком', () => {
    // Там это верно: в кэше профиль и компании ушедшего человека, следующий
    // увидел бы их до первого ответа сервера.
    expect(menu).toMatch(/qc\.clear\(\)/)
  })
})
