import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Панель «Мои задачи» обновляется вместе с задачами проекта.
 *
 * Панель показывает задачи ВСЕХ проектов компании и живёт на своём ключе.
 * Значит ни одна из четырнадцати точек, где сбрасывается ['tasks', projectId],
 * её не задевала: человек закрывал задачу, она исчезала из списка проекта и
 * оставалась в панели до следующего опроса — до минуты. Выглядело как
 * «сайдбар не синхронизируется».
 */

const appDir = join(import.meta.dirname, '../../../app/src')
const main = readFileSync(join(appDir, 'main.tsx'), 'utf8')
const panel = readFileSync(join(appDir, 'components/chat/MyTasksPanel.tsx'), 'utf8')
const socket = readFileSync(join(appDir, 'hooks/useProjectSocket.ts'), 'utf8')

describe('синхронизация панели моих задач', () => {
  it('сброс задач проекта тянет за собой мои', () => {
    /**
     * Одно правило вместо четырнадцати правок: дописывать вторую строчку в
     * каждую точку — гарантия забыть одну, а забытая проявится не сразу.
     */
    const rule = main.match(/getQueryCache\(\)\.subscribe\(\(event\) => \{[\s\S]*?\n\}\)/)?.[0] ?? ''
    expect(rule, 'правило связывания пропало').not.toBe('')
    expect(rule).toMatch(/event\.action\?\.type !== 'invalidate'/)
    expect(rule).toMatch(/queryKey\[0\] !== 'tasks'/)
    expect(rule).toMatch(/invalidateQueries\(\{ queryKey: \['my-tasks'\] \}\)/)
  })

  it('правило не зацикливается само на себе', () => {
    // Ключ панели — ['my-tasks'], условие ловит только 'tasks': совпадения
    // нет, и сброс панели не запускает правило заново.
    expect(panel).toMatch(/queryKey: \['my-tasks', companyId\]/)
  })

  it('чужие изменения тоже доходят', () => {
    // Сокет сбрасывает ['tasks'] — значит правило подхватит и правки от
    // других участников, без отдельной подписки в панели.
    expect(socket).toMatch(/tasks_changed[\s\S]{0,120}?queryKey: \['tasks', projectId\]/)
  })

  it('опрос остаётся страховкой', () => {
    // Сокет мог не дойти, вкладка — спать. Минута тут не про скорость, а про
    // то, что список не застрянет навсегда.
    expect(panel).toMatch(/refetchInterval: 60_000/)
  })
})
