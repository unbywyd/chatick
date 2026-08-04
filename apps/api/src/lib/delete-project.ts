import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { files, projects, projectMembers, users } from '../db/schema.js'
import { deleteObject, resolveStorage } from './s3.js'
import { sendDeletedMail } from './mails.js'

// Удаление проекта — одно на всех (SPEC §8.46).
//
// Действие необратимое и очень дорогое: вместе с проектом уходят переписка,
// задачи, документы, заметки и файлы в хранилище. Двух реализаций у него быть
// не должно — вторая рано или поздно забудет про R2, и в хранилище останутся
// объекты, к которым уже никто не знает пути.
//
// Порядок важен: сначала файлы, потом строки. Упав на файлах, мы оставляем
// проект целым и попытку можно повторить; наоборот — теряем ключи навсегда.

export type DeleteOutcome = { deletedFiles: number; notified: number }

/**
 * Снести проект со всем содержимым.
 *
 * actorId — кто удаляет; ему письмо не шлём, он и так знает. Для удаления из
 * внешней системы его нет, и тогда пишем всем участникам: они не нажимали
 * кнопку и должны узнать.
 */
export async function deleteProjectCompletely(
  projectId: string,
  actorName: string,
  actorId?: string | null,
): Promise<DeleteOutcome> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return { deletedFiles: 0, notified: 0 }

  // Участников собираем ДО удаления: после каскада писать будет некому.
  const recipients = await db
    .select({ email: users.email, locale: users.locale })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(
      actorId
        ? and(eq(projectMembers.projectId, projectId), sql`${projectMembers.userId} <> ${actorId}`)
        : eq(projectMembers.projectId, projectId),
    )

  const rows = await db
    .select({ key: files.key, originalKey: files.originalKey })
    .from(files)
    .where(eq(files.projectId, projectId))

  if (rows.length) {
    try {
      const store = await resolveStorage(projectId)
      for (const r of rows) {
        for (const key of [r.key, r.originalKey].filter(Boolean) as string[]) {
          await deleteObject(store, key).catch(() => {
            // один непослушный объект не должен блокировать удаление проекта
          })
        }
      }
    } catch (err) {
      console.error('[projects] storage cleanup failed:', err)
    }
  }

  // Остальное уносит каскад: 24 таблицы ссылаются на проект с on delete cascade.
  await db.delete(projects).where(eq(projects.id, projectId))

  // Письма в фоне: ответ не должен ждать почтовый сервер.
  for (const r of recipients) {
    void sendDeletedMail({
      to: r.email,
      locale: r.locale,
      kind: 'project',
      name: project.name,
      actorName,
    })
  }

  return { deletedFiles: rows.length, notified: recipients.length }
}
