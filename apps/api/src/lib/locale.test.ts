import { describe, it, expect, vi, beforeEach } from 'vitest'

// Выбор языка письма (SPEC §8.44).
//
// Ошибка здесь тихая: письмо уходит, доставляется, выглядит исправным — просто
// не на том языке. Узнают об этом от получателя, а не из логов.

const state = { user: null as any, project: null as any, company: null as any }

vi.mock('../db/client.js', () => ({
  db: {
    query: {
      users: { findFirst: async () => state.user },
      projects: { findFirst: async () => state.project },
      companies: { findFirst: async () => state.company },
    },
  },
}))
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }))
vi.mock('../db/schema.js', () => ({ users: {}, projects: {}, companies: {} }))

const { localeFor } = await import('./locale.js')

beforeEach(() => {
  state.user = null
  state.project = null
  state.company = null
})

describe('localeFor', () => {
  // Главный случай: человека завела внешняя система, приложение он не
  // открывал. locale = 'en' стоит потому, что колонка NOT NULL DEFAULT 'en',
  // а не потому, что он так решил.
  it('дефолтный en у заведённого извне не перебивает язык компании', async () => {
    state.user = { locale: 'en', localeSetByUser: false }
    state.company = { locale: 'he' }
    expect(await localeFor({ userId: 'u1', companyId: 'c1' })).toBe('he')
  })

  it('осознанный выбор человека сильнее языка компании', async () => {
    state.user = { locale: 'en', localeSetByUser: true }
    state.company = { locale: 'he' }
    expect(await localeFor({ userId: 'u1', companyId: 'c1' })).toBe('en')
  })

  it('язык проекта важнее языка компании', async () => {
    state.user = { locale: 'en', localeSetByUser: false }
    state.project = { locale: 'ru' }
    state.company = { locale: 'he' }
    expect(await localeFor({ userId: 'u1', projectId: 'p1', companyId: 'c1' })).toBe('ru')
  })

  it('без всего — английский', async () => {
    expect(await localeFor({})).toBe('en')
  })

  it('неизвестный язык не ломает выбор', async () => {
    state.user = { locale: 'klingon', localeSetByUser: true }
    expect(await localeFor({ userId: 'u1' })).toBe('en')
  })
})
