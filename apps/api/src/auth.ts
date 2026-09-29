import { SignJWT, jwtVerify } from 'jose'
import { createMiddleware } from 'hono/factory'
import { and, eq } from 'drizzle-orm'
import { db } from './db/client.js'
import { projectMembers, projects, users } from './db/schema.js'
import { env } from './env.js'

const secret = new TextEncoder().encode(env.JWT_SECRET)

// Двухступенчатая модель (см. CONCEPT.md):
//  session — личность после Google-логина; хватает для списка/создания проектов
//  project — сессия + выбранный проект и роль в нём; нужен для всего внутри проекта
export type SessionPayload = { typ: 'session'; sub: string; email: string }
export type ProjectPayload = {
  typ: 'project'
  sub: string
  email: string
  projectId: string
  role: 'owner' | 'admin' | 'member'
}
export type TokenPayload = SessionPayload | ProjectPayload

async function sign(payload: TokenPayload, expiresIn: string): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret)
}

export const signSessionToken = (p: Omit<SessionPayload, 'typ'>) =>
  sign({ typ: 'session', ...p }, '30d')

export const signProjectToken = (p: Omit<ProjectPayload, 'typ'>) =>
  sign({ typ: 'project', ...p }, '30d')

// Короткоживущий file-токен для прокси-отдачи (в URL: img/iframe/Google не шлют Authorization)
export async function signFileToken(fileId: string, projectId: string): Promise<string> {
  return new SignJWT({ typ: 'file', fileId, projectId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret)
}

export async function verifyFileToken(token: string): Promise<{ fileId: string; projectId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret)
    const p = payload as { typ?: string; fileId?: string; projectId?: string }
    if (p.typ !== 'file' || !p.fileId || !p.projectId) return null
    return { fileId: p.fileId, projectId: p.projectId }
  } catch {
    return null
  }
}

/**
 * Токен для картинок в адресе (<img src="…?t=">): img не умеет слать
 * Authorization.
 *
 * Раньше туда шёл проектный токен — полный доступ к проекту на месяц, и он
 * уходил наружу всякий раз, когда человек копировал адрес картинки. Сессионный
 * был бы ещё хуже: он открывает весь аккаунт. Этот годится только на чтение
 * картинок; права на каждый файл проверяются в базе при отдаче.
 */
export const signMediaToken = (sub: string) =>
  new SignJWT({ typ: 'media', sub }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('30d').sign(secret)

export async function verifyMediaToken(token: string): Promise<{ sub: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret)
    const p = payload as { typ?: string; sub?: string }
    return p.typ === 'media' && p.sub ? { sub: p.sub } : null
  } catch {
    return null
  }
}

export async function verifyToken(token: string): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret)
    // Подписью одним секретом подписаны и узкие токены — файловый, медиа.
    // Без этой проверки любой из них проходил бы как полноценная сессия.
    if (payload.typ !== 'session' && payload.typ !== 'project') return null
    return payload as unknown as TokenPayload
  } catch {
    return null
  }
}

function bearer(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined
}

export type SessionEnv = { Variables: { session: SessionPayload | ProjectPayload } }
export type ProjectEnv = { Variables: { auth: ProjectPayload } }

/** Любой валидный токен (session или project) — личность известна. */
export const requireSession = createMiddleware<SessionEnv>(async (c, next) => {
  const token = bearer(c.req.header('Authorization'))
  const payload = token ? await verifyToken(token) : null
  if (!payload) return c.json({ error: 'Unauthorized' }, 401)

  // Подписи мало: токен живёт месяц, а человека за это время могли удалить.
  // Раньше такой токен считался валидным до истечения срока, и приложение
  // работало от имени того, кого уже нет, — выбрасывало лишь случайно, когда
  // очередь доходила до ручки, которая сама лезет в базу за пользователем.
  const alive = await db.query.users.findFirst({
    where: eq(users.id, payload.sub),
    columns: { id: true },
  })
  if (!alive) return c.json({ error: 'Unauthorized' }, 401)

  c.set('session', payload)
  await next()
})

/**
 * Ручки внутри проекта. Проект приходит одним из двух способов:
 *
 *  - сессионный токен + X-Project — проект из адреса окна. Основной путь:
 *    проект в запросе ровно тот, что человек видит, подменить его нечем.
 *  - проектный токен (/enter) — старый путь. Его шлют бандлы, выпущенные до
 *    перехода на адрес и ещё живущие в кэшах браузеров. Убирать — только
 *    когда их не останется.
 *
 * В обоих случаях членство и роль берутся из базы, а не из токена.
 */
export const requireProject = createMiddleware<ProjectEnv>(async (c, next) => {
  const token = bearer(c.req.header('Authorization'))
  const payload = token ? await verifyToken(token) : null
  const claimed = c.req.header('x-project')

  let projectId: string
  if (payload?.typ === 'project') {
    // Клиент называет проект из адреса окна (X-Project). Слот токена в клиенте
    // один, и его подменяли под ногами: окно показывало один проект, токен был
    // от другого — и таблица задач наполнялась чужими. Отдавать данные не того
    // проекта нельзя ни при каком расхождении; по 409 клиент обменивает токен.
    if (claimed && claimed !== payload.projectId) {
      return c.json({ error: 'Project token belongs to another project than the page; re-enter the project' }, 409)
    }
    projectId = payload.projectId
  } else if (payload?.typ === 'session' && claimed) {
    projectId = claimed
  } else {
    return c.json({ error: 'Project token required' }, 401)
  }

  // Токен живёт 30 дней, а членство кончается в тот момент, когда человека
  // исключили. Верить проекту и роли из токена — значит оставлять исключённому
  // доступ до конца срока: он продолжал читать и писать в чат и видеть ленту
  // (там, где нет hasPermission, ходящего в базу).
  //
  // Роль тоже берём из базы, а не из токена: понижённый из админов до
  // участника иначе сохранял бы админские права до перевыпуска.
  const membership = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, payload.sub)),
    columns: { role: true, rulesAcceptedAt: true },
  })

  if (payload.typ === 'session') {
    if (!membership) {
      // 404 и 403 клиент объясняет по-разному: «проекта больше нет» против
      // «вы не в команде». Лишний запрос — только на пути отказа.
      const exists = await db.query.projects.findFirst({ where: eq(projects.id, projectId), columns: { id: true } })
      return exists ? c.json({ error: 'Forbidden' }, 403) : c.json({ error: 'Not found' }, 404)
    }
    // Правила чата принимаются до первого входа (SPEC §4.2). Проектный токен
    // выдавался только после согласия; без токена ту же дверь держим здесь.
    if (!membership.rulesAcceptedAt) {
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        columns: { name: true, chatRules: true },
      })
      return c.json(
        { error: 'Chat rules not accepted', needRulesAccept: true, chatRules: project?.chatRules ?? '', projectName: project?.name ?? '' },
        428,
      )
    }
  }
  if (!membership) return c.json({ error: 'Forbidden' }, 403)

  c.set('auth', { typ: 'project', sub: payload.sub, email: payload.email, projectId, role: membership.role })
  await next()
})
