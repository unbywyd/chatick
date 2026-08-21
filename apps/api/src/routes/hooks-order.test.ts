import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Хуки объявлены до раннего выхода из компонента.
 *
 * В ленте уведомлений useState стоял ПОСЛЕ `if (!items.length) return null`.
 * Пока уведомлений не было, хук не вызывался; пришло первое — число хуков
 * между отрисовками изменилось, и React упал с «Rendered more hooks than
 * during the previous render». Экран становился белым.
 *
 * Типы такое не ловят — правило React, а не TypeScript.
 */

const appDir = join(import.meta.dirname, '../../../app/src')

/** Файлы, где ранний выход соседствует с состоянием. */
const FILES = [
  'components/ProjectInbox.tsx',
  'components/chat/MyTasksPanel.tsx',
  'components/NotificationDialog.tsx',
]

describe('порядок хуков', () => {
  for (const file of FILES) {
    it(`${file}: ни один хук не стоит за ранним return`, () => {
      const src = readFileSync(join(appDir, file), 'utf8')

      /**
       * Берём тело компонента: от `export function` до конца файла. Ранний
       * выход — `return` на верхнем уровне (два пробела отступа), а не внутри
       * вложенных функций и не финальный `return (` с разметкой.
       */
      const body = src.slice(src.search(/export function [A-Z]/))
      const early = body.search(/\n  if \([^\n]*\) return [^\n]*\n/)
      if (early === -1) return // раннего выхода нет — проверять нечего

      const after = body.slice(early)
      /**
       * `(` или `<`: useState<Notification | null>(null) — обобщённый тип, и
       * шаблон, требующий скобку сразу после имени, его не видел. Хук можно
       * было увести за ранний return при зелёном тесте — проверено саботажем.
       */
      const hooks = [...after.matchAll(/\buse[A-Z]\w*\s*[(<]/g)].map((m) => m[0])
      expect(hooks, `${file}: хуки после раннего return — экран упадёт`).toEqual([])
    })
  }
})
