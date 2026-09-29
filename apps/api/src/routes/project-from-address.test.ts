import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Проект — из адреса окна, а не из проектного токена.
 *
 * Слот проектного токена в клиенте один, и его подменяли под ногами: окно
 * показывало один проект, запросы уходили в другой. Три бага одной схемы.
 * Теперь клиент шлёт сессию и X-Project, а сервер проверяет членство в базе.
 *
 * Старый путь (проектный токен из /enter) обязан работать, пока в кэшах
 * браузеров живут бандлы, выпущенные до перехода. Живая проверка обоих путей
 * на копии базы — scratchpad routing-e2e.mts; здесь — правила, которые нельзя
 * потерять при правках.
 */

const src = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8').replace(/\r\n/g, '\n')
const auth = src('auth.ts')
const ws = src('ws.ts')
const yjs = src('yjs.ts')
const files = src('routes/files.ts')
const authRoute = src('routes/auth.ts')
const projects = src('routes/projects.ts')

describe('requireProject принимает оба пути', () => {
  it('сессия + X-Project — проект из заголовка', () => {
    expect(auth).toContain("} else if (payload?.typ === 'session' && claimed) {")
    expect(auth).toContain('projectId = claimed')
  })

  it('старый проектный токен по-прежнему проходит, и расхождение с адресом — 409', () => {
    // Саботаж: убрать ветку project — старые бандлы получат 401 на всё.
    expect(auth).toContain("if (payload?.typ === 'project') {")
    expect(auth).toContain('if (claimed && claimed !== payload.projectId)')
  })

  it('членство и роль — из базы по проекту запроса, не из токена', () => {
    expect(auth).toContain('where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, payload.sub))')
    expect(auth).toContain("c.set('auth', { typ: 'project', sub: payload.sub, email: payload.email, projectId, role: membership.role })")
  })

  it('без токена правила чата держит сам requireProject (428)', () => {
    // Проектный токен выдавался только после согласия. Без токена эту дверь
    // держать больше некому — саботаж: убрать проверку, и правила обходятся.
    expect(auth).toContain('if (!membership.rulesAcceptedAt) {')
    expect(auth).toMatch(/needRulesAccept: true[\s\S]{0,200}428/)
  })

  it('согласие с правилами — отдельной ручкой, /enter остаётся для старых бандлов', () => {
    expect(projects).toContain("projectsRoute.post('/:projectId/rules/accept'")
    expect(projects).toContain("'/:projectId/enter',")
  })
})

describe('узкие токены не становятся сессией', () => {
  it('verifyToken признаёт только session и project', () => {
    // Живой саботаж показал: без этой строки медиа-токен открывал /auth/me
    // (200), а файловый ронял сервер (500).
    expect(auth).toContain("if (payload.typ !== 'session' && payload.typ !== 'project') return null")
  })

  it('медиа-токен выдаётся только из сессии и годится только на картинки', () => {
    expect(authRoute).toContain("auth.post('/media-token', requireSession")
    expect(authRoute).toContain("if (session.typ !== 'session') return c.json({ error: 'Session token required' }, 401)")
    expect(files.match(/verifyMediaToken\(bearer\)/g)?.length).toBe(2)
    // Проекта в медиа-токене нет: право проверяется по проекту самого файла.
    expect(files).toContain("if (!(await hasPermission(file.projectId, userId, 'files.read')))")
    expect(files).toContain("if (!(await hasPermission(doc.projectId, sub, 'documents.read')))")
  })
})

describe('сокеты', () => {
  it('ws: проект из адреса пускается только участнику, принявшему правила', () => {
    expect(ws).toContain("const claimed = url.searchParams.get('project')")
    expect(ws).toContain('if (!m || !m.rulesAcceptedAt) {')
    expect(ws).toContain("ws.close(4003, 'forbidden')")
  })

  it('yjs: проект берётся у документа, чужая открытая комната не отдаётся', () => {
    expect(yjs).toContain("const d = await db.query.documents.findFirst({ where: eq(documents.id, documentId), columns: { projectId: true } })")
    // Была дыра: открытая комната возвращалась без сверки проекта.
    expect(yjs).toContain('if (existing && existing.projectId !== projectId) return null')
  })
})
