import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { projectIntegrations, releases, releaseEvents } from '../db/schema.js'
import { requireProject, type ProjectEnv } from '../auth.js'
import { hasPermission } from './projects.js'
import { isFeatureEnabled } from '../lib/features.js'
import { logActivity } from '../lib/audit.js'
import { broadcast } from '../ws.js'
import { notifyReleaseStage } from './releases.js'
import {
  eventComment,
  integrationBySecret,
  matchRelease,
  stageForStatus,
  verifyExpoSignature,
  type ExpoBuildPayload,
} from '../lib/expo-webhook.js'

/**
 * Интеграции проекта с внешними системами сборки (пока только Expo/EAS).
 *
 * Две разные вещи в одном файле, и это намеренно: настройка требует прав, а
 * приём вебхука публичен — держать их рядом дешевле, чем искать по проекту,
 * где именно проверяется секрет.
 */
export const integrationsRoute = new Hono<ProjectEnv>()
integrationsRoute.use('*', requireProject)

const API = () => (process.env.API_PUBLIC_URL || 'https://api.chatick.com').replace(/\/$/, '')

/** Настраивать интеграцию вправе те же, кто ведёт релизы. */
async function guard(c: { get: (k: 'auth') => { projectId: string; sub: string } }) {
  const { projectId, sub } = c.get('auth')
  if (!(await isFeatureEnabled(projectId, 'releases'))) {
    return { error: 'Releases are turned off for this project', status: 404 as const }
  }
  if (!(await hasPermission(projectId, sub, 'releases.manage'))) {
    return { error: 'Forbidden: releases.manage is required', status: 403 as const }
  }
  return { projectId, sub }
}

integrationsRoute.get('/expo', async (c) => {
  const g = await guard(c as never)
  if ('error' in g) return c.json({ error: g.error }, g.status)

  const row = await db.query.projectIntegrations.findFirst({
    where: and(eq(projectIntegrations.projectId, g.projectId), eq(projectIntegrations.kind, 'expo')),
  })
  if (!row) return c.json({ connected: false })
  return c.json({
    connected: true,
    // Адрес и секрет показываем целиком: их вставляют в eas webhook:create, а
    // спрятанный наполовину секрет невозможно скопировать.
    url: `${API()}/hooks/expo/${row.secret}`,
    secret: row.secret,
    lastEventAt: row.lastEventAt,
    createdAt: row.createdAt,
  })
})

integrationsRoute.post('/expo', async (c) => {
  const g = await guard(c as never)
  if ('error' in g) return c.json({ error: g.error }, g.status)

  const existing = await db.query.projectIntegrations.findFirst({
    where: and(eq(projectIntegrations.projectId, g.projectId), eq(projectIntegrations.kind, 'expo')),
  })
  // Повторное подключение возвращает тот же секрет, а не выдаёт новый: иначе
  // человек, нажавший кнопку дважды, тихо сломал бы уже настроенный вебхук.
  if (existing) {
    return c.json({ connected: true, url: `${API()}/hooks/expo/${existing.secret}`, secret: existing.secret })
  }

  // 32 символа: у EAS минимум 16, запас берём вдвое.
  const secret = randomBytes(24).toString('base64url').slice(0, 32)
  const [row] = await db
    .insert(projectIntegrations)
    .values({ projectId: g.projectId, kind: 'expo', secret, createdById: g.sub })
    .returning()
  void logActivity({
    projectId: g.projectId,
    actorId: g.sub,
    action: 'create',
    entityType: 'project',
    entityLabel: 'Expo integration',
  })
  return c.json({ connected: true, url: `${API()}/hooks/expo/${row!.secret}`, secret: row!.secret }, 201)
})

integrationsRoute.delete('/expo', async (c) => {
  const g = await guard(c as never)
  if ('error' in g) return c.json({ error: g.error }, g.status)
  // Отключение НЕ трогает версии: они факт, а интеграция лишь способ их
  // заводить. Со стороны Expo вебхук надо снять отдельно — сказать об этом
  // должен интерфейс, здесь мы про чужую систему ничего не можем.
  await db
    .delete(projectIntegrations)
    .where(and(eq(projectIntegrations.projectId, g.projectId), eq(projectIntegrations.kind, 'expo')))
  return c.json({ connected: false })
})

/**
 * Приём вебхука от EAS. БЕЗ сессии: зовёт чужой сервер.
 *
 * Отдельный роутер, потому что requireProject здесь неуместен — подлинность
 * подтверждает подпись, а не токен человека.
 */
export const expoHookRoute = new Hono()

expoHookRoute.post('/expo/:secret', async (c) => {
  const secret = c.req.param('secret')
  const integration = await integrationBySecret(secret)
  // Отвечаем 404 одинаково и на неизвестный секрет, и на выключенную функцию:
  // разница в ответах подсказывала бы перебирающему, что секрет угадан.
  if (!integration) return c.json({ error: 'Not found' }, 404)

  // Тело нужно СЫРЫМ: подпись считается по байтам, а JSON.parse + stringify
  // переставит ключи и пробелы, и подпись перестанет сходиться.
  const raw = await c.req.text()
  if (!verifyExpoSignature(raw, c.req.header('expo-signature'), integration.secret)) {
    return c.json({ error: 'Bad signature' }, 401)
  }

  let payload: ExpoBuildPayload
  try {
    payload = JSON.parse(raw) as ExpoBuildPayload
  } catch {
    return c.json({ error: 'Bad JSON' }, 400)
  }

  await db
    .update(projectIntegrations)
    .set({ lastEventAt: new Date() })
    .where(eq(projectIntegrations.id, integration.id))

  const matched = await matchRelease(integration.projectId, payload)
  // Сборку не удалось сопоставить (чужая платформа, нет версии) — отвечаем 200
  // и молчим: EAS на 4xx будет повторять, а повторять тут нечего.
  if (!matched) return c.json({ ok: true, matched: false })

  const { release, created } = matched
  const next = stageForStatus(release.buildType, payload.status)
  const comment = eventComment(payload)

  // Две ссылки, и обе нужны: артефакт скачивают, страницу в EAS открывают
  // ради логов. Когда сборка упала, артефакта нет, а логи — единственное, что
  // человеку и требуется.
  const patch: Record<string, unknown> = {}
  const artifact = payload.artifacts?.buildUrl ?? null
  const page = payload.buildDetailsPageUrl ?? null
  if (artifact && artifact !== release.referenceUrl) patch.referenceUrl = artifact
  if (page && page !== release.buildPageUrl) patch.buildPageUrl = page
  if (Object.keys(patch).length) {
    await db.update(releases).set({ ...patch, updatedAt: new Date() }).where(eq(releases.id, release.id))
  }

  // Запись в ленту делаем ВСЕГДА, даже когда стадия не меняется: «сборка
  // упала» — это то, ради чего человек сюда и смотрит.
  const moved = Boolean(next && next !== release.status)
  await db.insert(releaseEvents).values({
    releaseId: release.id,
    status: moved ? next! : release.status,
    fromStatus: moved ? release.status : null,
    comment,
    actorId: null,
  })
  if (moved) {
    await db.update(releases).set({ status: next!, updatedAt: new Date() }).where(eq(releases.id, release.id))
    void notifyReleaseStage(integration.projectId, '', release, next!)
  }

  broadcast(integration.projectId, 'releases_changed', {})
  return c.json({ ok: true, matched: true, created, releaseId: release.id, moved })
})
