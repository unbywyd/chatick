import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Полоса уведомлений в проекте не должна пропадать из-за лимита.
 *
 * Клиент брал сотню самых свежих уведомлений и отфильтровывал из неё нужный
 * проект. У человека с двумя сотнями непрочитанных старые в сотню не
 * попадали: массив после фильтра пустел, полоса исчезала целиком — а бейдж
 * рядом честно показывал их число.
 *
 * Живой случай: 15 уведомлений проекта Leanka занимали в общем списке позиции
 * 133–173 при лимите 100. В полосе было 0, стало 15.
 */

const api = readFileSync(join(import.meta.dirname, 'inbox.ts'), 'utf8').replace(/\r\n/g, '\n')
const client = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/ProjectInbox.tsx'),
  'utf8',
).replace(/\r\n/g, '\n')

describe('отбор по проекту делает сервер', () => {
  it('ручка принимает projectId', () => {
    // Саботаж: убрать параметр — тест падает.
    expect(api, 'ручка не принимает projectId').toContain('projectId: z.string().optional()')
    expect(api, 'projectId не попадает в условия').toContain(
      'if (projectId) conds.push(eq(notifications.projectId, projectId))',
    )
  })

  it('счётчик считает то же, что показывает список', () => {
    // Иначе бейдж снова разойдётся с тем, что человек видит, — ровно та
    // беда, из-за которой всё и затевалось.
    //
    // Саботаж: убрать projectId из подсчёта — тест падает.
    expect(api, 'счётчик не сужается по проекту').toContain(
      'projectId ? eq(notifications.projectId, projectId) : undefined',
    )
  })

  it('клиент просит проект, а не фильтрует полученное', () => {
    // Саботаж: вернуть фильтр по n.projectId на клиенте — тест падает.
    expect(client, 'проект не запрашивается у сервера').toContain('&projectId=${encodeURIComponent(projectId)}')
    expect(client, 'клиент всё ещё фильтрует сотню сам').not.toContain('n.projectId === projectId')
  })

  it('проект входит в ключ запроса', () => {
    // Без него React Query отдал бы кеш компании при заходе в проект: полоса
    // показала бы чужие уведомления.
    //
    // Саботаж: убрать projectId из queryKey — тест падает.
    expect(client, 'проект не в ключе кеша').toContain("queryKey: ['inbox', companyId ?? 'all', projectId ?? 'company']")
  })
})
