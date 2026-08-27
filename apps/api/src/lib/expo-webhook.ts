import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { projectIntegrations, releases, releaseEvents } from '../db/schema.js'
import { buildType, firstStage, isValidStage } from './release-stages.js'

/**
 * Приём сборок из Expo (EAS).
 *
 * EAS после каждой сборки шлёт POST с телом, подписанным общим секретом.
 * Проверено по документации Expo: заголовок `expo-signature`, HMAC-SHA1 от
 * сырого тела, формат `sha1=<hex>`.
 *
 * Что это даёт: разработчик запускает `eas build` и в Chatick не заходит
 * вовсе — версия сама переезжает со «Собирается» на следующую стадию, и к ней
 * прикрепляется ссылка на артефакт. Дальше (TestFlight, ревью, публикация)
 * по-прежнему руками: EAS о магазинах ничего не знает и знать не может.
 */

/** Тело вебхука. Поля — те, что EAS реально шлёт; остальные нам не нужны. */
export type ExpoBuildPayload = {
  id?: string
  status?: string
  platform?: string
  appVersion?: string
  buildProfile?: string
  projectName?: string
  buildDetailsPageUrl?: string
  artifacts?: { buildUrl?: string; applicationArchiveUrl?: string }
  metadata?: { appName?: string; appVersion?: string; buildProfile?: string }
  error?: { message?: string } | null
}

/**
 * Подпись подлинная?
 *
 * Сравнение через timingSafeEqual, а не ===: обычное сравнение строк выходит
 * раньше на первом несовпавшем символе, и по времени ответа подпись можно
 * подобрать побайтно. Здесь это не теория — ручка публичная и двигает релизы.
 */
export function verifyExpoSignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false
  const expected = `sha1=${createHmac('sha1', secret).update(rawBody).digest('hex')}`
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Платформа EAS → наш тип сборки.
 *
 * Совпадают буквально, но отображение явное: если завтра появится третья
 * платформа, лучше получить null и пропустить сборку, чем записать мусор в
 * поле, по которому строится сводка «что в проде».
 */
export function buildTypeOf(platform: string | undefined): string | null {
  if (platform === 'ios' || platform === 'android') return platform
  return null
}

/**
 * Стадия по статусу сборки.
 *
 * EAS отвечает только за саму сборку: `finished` значит «собралось», а не
 * «доехало до людей». Дальше «собрана» не двигаем — раздать её людям решает
 * человек.
 *
 * Раньше здесь возвращалась stages[0] с комментарием «снимаем собирается» —
 * а stages[0] и ЕСТЬ «собирается». Версия приходила из EAS готовой и вставала
 * в «Собирается» навсегда: в Expo зелёная галочка, у нас идёт сборка. Чтобы
 * это исправить, люди ставили TestFlight руками — хотя в TestFlight сборку
 * никто не заливал, и стадия врала уже по-другому.
 *
 * Настоящих состояний три, а ступеней было две: идёт → лежит в EAS → роздана.
 * Средней не существовало, отсюда и выбор между двумя неправдами.
 *
 * `errored` не откатывает стадию: версия остаётся там, где была, а факт
 * падения попадает в ленту комментарием. Откат затёр бы то, что человек уже
 * успел сделать руками.
 */
export function stageForStatus(type: string, status: string | undefined): string | null {
  if (status !== 'finished') return null
  const stages = buildType(type)?.stages ?? []
  // Ищем ступень по имени, а не по номеру: у лестницы «other» сборки нет
  // вовсе, и второй ступенью там стоит «Готово и доступно» — вебхук объявил
  // бы выкаченным то, что просто собралось.
  return stages.find((s) => s.key === 'built')?.key ?? null
}

/** Человекочитаемая строка для ленты: что именно приехало. */
export function eventComment(p: ExpoBuildPayload): string {
  if (p.status === 'errored') {
    const msg = p.error?.message?.trim()
    return msg ? `EAS: сборка упала — ${msg.slice(0, 300)}` : 'EAS: сборка упала'
  }
  if (p.status === 'finished') return 'EAS: сборка готова'
  return `EAS: ${p.status ?? 'событие'}`
}

/**
 * Находит версию под пришедшую сборку — или заводит новую.
 *
 * Ищем по тройке «проект + имя сборки + тип»: имя различает клиента и
 * провайдера, без него сборки двух приложений были бы неотличимы.
 *
 * Не нашли — создаём. Разработчик часто собирает раньше, чем менеджер завёл
 * версию, и потерять сборку хуже, чем получить лишнюю строку: строку видно и
 * можно поправить, а пропавшую сборку никто не ищет.
 */
export async function matchRelease(
  projectId: string,
  p: ExpoBuildPayload,
): Promise<{ release: typeof releases.$inferSelect; created: boolean } | null> {
  const type = buildTypeOf(p.platform)
  if (!type) return null

  const version = (p.appVersion ?? p.metadata?.appVersion ?? '').trim()
  if (!version) return null
  const appName = (p.projectName ?? p.metadata?.appName ?? '').trim() || null
  const profile = (p.buildProfile ?? p.metadata?.buildProfile ?? '').trim() || null

  const candidates = await db
    .select()
    .from(releases)
    .where(and(eq(releases.projectId, projectId), eq(releases.buildType, type), eq(releases.version, version)))
    .orderBy(desc(releases.createdAt))

  // Имя сборки сходится — берём её. Если у версии имени нет (заведена до того,
  // как поле появилось), считаем совпадением: приложение в проекте одно.
  const found = candidates.find((r) => !r.appName || !appName || r.appName === appName)
  if (found) return { release: found, created: false }

  const status = firstStage(type)!
  const [row] = await db
    .insert(releases)
    .values({
      projectId,
      version,
      appName,
      buildType: type,
      status,
      buildProfile: profile,
      ownerId: null,
      referenceUrl: p.artifacts?.buildUrl ?? null,
      buildPageUrl: p.buildDetailsPageUrl ?? null,
    })
    .returning()
  await db.insert(releaseEvents).values({
    releaseId: row!.id,
    status,
    fromStatus: null,
    comment: 'EAS: версия заведена автоматически по сборке',
    actorId: null,
  })
  return { release: row!, created: true }
}

/** Интеграция проекта — по секрету из адреса вебхука. */
export async function integrationBySecret(secret: string) {
  const row = await db.query.projectIntegrations.findFirst({
    where: and(eq(projectIntegrations.kind, 'expo'), eq(projectIntegrations.secret, secret)),
  })
  return row ?? null
}

export { isValidStage }
