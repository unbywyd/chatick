import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  activityLog,
  chatSummaries,
  companies,
  companyMembers,
  credentials,
  documents,
  notes as projectNotes,
  timeEntries,
  documentVersions,
  files,
  messages,
  projectMembers,
  projects,
  resourceSecrets,
  taskComments,
  taskGroups,
  taskNotes,
  tasks,
  users,
} from '../db/schema.js'
import { decrypt, encrypt } from './crypto.js'

// Экспорт/импорт компании (SPEC §8.28).
//
// Задача не «выгрузить на посмотреть», а дать полноценный ОБРАТИМЫЙ бэкап:
// компания должна иметь возможность забрать свои данные и вернуть их —
// к нам же или в свою инсталляцию. Поэтому формат самодостаточный и открытый.

export const BACKUP_VERSION = 1

/** Люди хранятся по email: id пользователей у другой инсталляции свои. */
type PersonRef = { email: string; name: string }

export type BackupFile = {
  version: number
  exportedAt: string
  source: { app: string; companyId: string }
  company: Record<string, unknown>
  members: (PersonRef & { role: string })[]
  projects: {
    project: Record<string, unknown>
    members: (PersonRef & { role: string; permissions: string; jobTitle: string; responsibility: string })[]
    sprints: Record<string, unknown>[]
    tasks: Record<string, unknown>[]
    taskComments: Record<string, unknown>[]
    taskNotes: Record<string, unknown>[]
    documents: Record<string, unknown>[]
    projectNotes?: Record<string, unknown>[]
    timeEntries?: Record<string, unknown>[]
    documentVersions: Record<string, unknown>[]
    messages: Record<string, unknown>[]
    chatSummaries: Record<string, unknown>[]
    resources: Record<string, unknown>[]
    /** Присутствуют, только если экспорт защищён паролем. */
    resourceSecrets?: Record<string, unknown>[]
    files: Record<string, unknown>[]
    activity: Record<string, unknown>[]
  }[]
  /** Пометка, что секреты в архиве зашифрованы паролем пользователя. */
  secretsEncrypted: boolean
}

// --- Шифрование секретов паролем пользователя -------------------------------
// Наш ключ в архив не уезжает: иначе секреты нельзя восстановить нигде, кроме
// нашего сервера, и бэкап неполон. Пароль знает только владелец компании.

const SALT_LEN = 16
const IV_LEN = 12

function keyFrom(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32)
}

export function encryptWithPassword(plain: string, password: string): string {
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', keyFrom(password, salt), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([salt, iv, cipher.getAuthTag(), enc]).toString('base64')
}

export function decryptWithPassword(payload: string, password: string): string {
  const raw = Buffer.from(payload, 'base64')
  const salt = raw.subarray(0, SALT_LEN)
  const iv = raw.subarray(SALT_LEN, SALT_LEN + IV_LEN)
  const tag = raw.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + 16)
  const data = raw.subarray(SALT_LEN + IV_LEN + 16)
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(password, salt), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

// --- Экспорт ----------------------------------------------------------------

/** Заменяет userId на email+имя: при импорте люди сопоставляются по почте. */
function personMap(rows: { id: string; email: string; name: string }[]) {
  return new Map(rows.map((u) => [u.id, { email: u.email, name: u.name }]))
}
const refOf = (map: Map<string, PersonRef>, id: string | null) => (id ? (map.get(id) ?? null) : null)

export async function exportCompany(companyId: string, password?: string): Promise<BackupFile> {
  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) })
  if (!company) throw new Error('Company not found')

  const cMembers = await db
    .select({ m: companyMembers, u: users })
    .from(companyMembers)
    .innerJoin(users, eq(users.id, companyMembers.userId))
    .where(eq(companyMembers.companyId, companyId))

  const projectRows = await db.query.projects.findMany({ where: eq(projects.companyId, companyId) })
  const projectIds = projectRows.map((p) => p.id)

  // все причастные пользователи одним запросом — чтобы не ходить в БД на каждую строку
  const allUsers = await db.query.users.findMany()
  const people = personMap(allUsers)

  const out: BackupFile['projects'] = []
  for (const project of projectRows) {
    const pid = project.id
    const [pMembers, sprints, taskRows, comments, notes, docs, docVersions, msgs, summaries, resources, fileRows, activity, journalNotes, timeRows] =
      await Promise.all([
        db
          .select({ m: projectMembers, u: users })
          .from(projectMembers)
          .innerJoin(users, eq(users.id, projectMembers.userId))
          .where(eq(projectMembers.projectId, pid)),
        db.query.taskGroups.findMany({ where: eq(taskGroups.projectId, pid) }),
        db.query.tasks.findMany({ where: eq(tasks.projectId, pid) }),
        db.query.taskComments.findMany({ where: eq(taskComments.projectId, pid) }),
        db.query.taskNotes.findMany({ where: eq(taskNotes.projectId, pid) }),
        db.query.documents.findMany({ where: eq(documents.projectId, pid) }),
        db.query.documentVersions.findMany({}),
        db.query.messages.findMany({ where: eq(messages.projectId, pid) }),
        db.query.chatSummaries.findMany({ where: eq(chatSummaries.projectId, pid) }),
        db.query.credentials.findMany({ where: eq(credentials.projectId, pid) }),
        db.query.files.findMany({ where: eq(files.projectId, pid) }),
        db.query.activityLog.findMany({ where: eq(activityLog.projectId, pid) }),
        db.query.notes.findMany({ where: eq(projectNotes.projectId, pid) }),
        db.query.timeEntries.findMany({ where: eq(timeEntries.projectId, pid) }),
      ])

    const docIds = new Set(docs.map((d) => d.id))

    // Секреты кладём, только если задан пароль: иначе они бесполезны (зашифрованы
    // нашим ключом) — а класть их в открытую нельзя.
    let secretsOut: Record<string, unknown>[] | undefined
    if (password && resources.length) {
      const secrets = await db.query.resourceSecrets.findMany({
        where: inArray(
          resourceSecrets.resourceId,
          resources.map((r) => r.id),
        ),
      })
      secretsOut = secrets.map((s) => {
        let value = ''
        try {
          value = decrypt(s.valueEncrypted)
        } catch {
          value = '' // ключ сменился — секрет потерян, но экспорт не валим
        }
        return {
          id: s.id,
          resourceId: s.resourceId,
          label: s.label,
          // перешифровано паролем владельца: мы этот архив прочитать не можем
          value: value ? encryptWithPassword(value, password) : '',
          createdAt: s.createdAt,
        }
      })
    }

    out.push({
      project: { ...project },
      members: pMembers.map((r) => ({
        email: r.u.email,
        name: r.u.name,
        role: r.m.role,
        permissions: r.m.permissions,
        jobTitle: r.m.jobTitle,
        responsibility: r.m.responsibility,
      })),
      sprints: sprints.map((s) => ({ ...s, createdBy: refOf(people, s.createdById) })),
      tasks: taskRows.map((t) => ({
        ...t,
        assignee: refOf(people, t.assigneeId),
        createdBy: refOf(people, t.createdById),
      })),
      taskComments: comments.map((c) => ({ ...c, author: refOf(people, c.authorId) })),
      taskNotes: notes.map((n) => ({ ...n })),
      // журнал проекта (SPEC §8.31): решения, противоречия, напоминания
      projectNotes: journalNotes.map((n) => ({ ...n, author: refOf(people, n.authorId) })),
      // учёт времени (SPEC §8.32): часы — то, за что платят, терять их нельзя
      timeEntries: timeRows.map((e) => ({ ...e, user: refOf(people, e.userId) })),
      documents: docs.map((d) => ({
        ...d,
        createdBy: refOf(people, d.createdById),
        updatedBy: refOf(people, d.updatedById),
      })),
      documentVersions: docVersions
        .filter((v) => docIds.has(v.documentId))
        .map((v) => ({ ...v, author: refOf(people, v.authorId) })),
      messages: msgs.map((m) => ({ ...m, author: refOf(people, m.authorId) })),
      chatSummaries: summaries.map((s) => ({ ...s })),
      resources: resources.map((r) => ({ ...r, createdBy: refOf(people, r.createdById) })),
      ...(secretsOut ? { resourceSecrets: secretsOut } : {}),
      files: fileRows.map((f) => ({ ...f, uploadedBy: refOf(people, f.uploadedById) })),
      activity: activity.map((a) => ({ ...a, actor: refOf(people, a.actorId) })),
    })
  }

  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    source: { app: 'chatick', companyId },
    company: { ...company, llmKeyEncrypted: undefined }, // чужой ключ модели не выгружаем
    members: cMembers.map((r) => ({ email: r.u.email, name: r.u.name, role: r.m.role })),
    projects: out,
    secretsEncrypted: Boolean(password),
  }
}

/** Сводка для UI: что попадёт в архив. */
export async function exportSummary(companyId: string) {
  const projectRows = await db.query.projects.findMany({ where: eq(projects.companyId, companyId) })
  const ids = projectRows.map((p) => p.id)
  if (!ids.length) return { projects: 0, tasks: 0, documents: 0, messages: 0, files: 0, filesBytes: 0 }

  const [t, d, m, f] = await Promise.all([
    db.query.tasks.findMany({ where: inArray(tasks.projectId, ids) }),
    db.query.documents.findMany({ where: inArray(documents.projectId, ids) }),
    db.query.messages.findMany({ where: inArray(messages.projectId, ids) }),
    db.query.files.findMany({ where: inArray(files.projectId, ids) }),
  ])
  return {
    projects: projectRows.length,
    tasks: t.length,
    documents: d.length,
    messages: m.length,
    files: f.length,
    filesBytes: f.reduce((sum, x) => sum + Number(x.size || 0), 0),
  }
}

// --- Импорт -----------------------------------------------------------------

export type ImportResult = {
  companyId: string
  created: Record<string, number>
  warnings: string[]
}

/**
 * Импорт архива. Создаёт НОВУЮ компанию — никогда не перезаписывает
 * существующую: слияние двух историй молча потеряло бы данные, а
 * восстановление должно быть предсказуемым.
 *
 * Люди сопоставляются по email; отсутствующих заводим, чтобы не потерять
 * авторство задач и сообщений.
 */
export async function importCompany(
  backup: BackupFile,
  importerUserId: string,
  password?: string,
): Promise<ImportResult> {
  if (backup.version > BACKUP_VERSION) {
    throw new Error(`Backup version ${backup.version} is newer than supported (${BACKUP_VERSION})`)
  }
  const created: Record<string, number> = {}
  const warnings: string[] = []
  const bump = (k: string, n = 1) => (created[k] = (created[k] ?? 0) + n)

  const src = backup.company as Record<string, unknown>
  const [company] = await db
    .insert(companies)
    .values({
      name: String(src.name ?? 'Imported company'),
      logoUrl: (src.logoUrl as string) ?? null,
      storageLimit: String(src.storageLimit ?? 5 * 1024 * 1024 * 1024),
      maxProjects: String(src.maxProjects ?? '0'),
      maxMembers: String(src.maxMembers ?? '0'),
      plan: String(src.plan ?? 'free'),
    })
    .returning()
  bump('companies')

  const userIdByEmail = new Map<string, string>()
  async function userFor(ref: PersonRef | null | undefined): Promise<string | null> {
    if (!ref?.email) return null
    const email = ref.email.toLowerCase()
    const cached = userIdByEmail.get(email)
    if (cached) return cached
    const existing = await db.query.users.findFirst({ where: eq(users.email, email) })
    if (existing) {
      userIdByEmail.set(email, existing.id)
      return existing.id
    }
    const [u] = await db.insert(users).values({ email, name: ref.name || email }).returning()
    userIdByEmail.set(email, u!.id)
    bump('users')
    return u!.id
  }

  // импортирующий обязан остаться админом, иначе потеряет доступ к восстановленному
  await db.insert(companyMembers).values({ companyId: company!.id, userId: importerUserId, role: 'admin' })

  for (const m of backup.members) {
    const uid = await userFor(m)
    if (!uid || uid === importerUserId) continue
    await db
      .insert(companyMembers)
      .values({ companyId: company!.id, userId: uid, role: (m.role as 'member') ?? 'member' })
      .onConflictDoNothing()
    bump('companyMembers')
  }

  for (const p of backup.projects) {
    const ps = p.project as Record<string, unknown>
    // slug уникален глобально — при повторном импорте обязателен новый
    const [project] = await db
      .insert(projects)
      .values({
        companyId: company!.id,
        name: String(ps.name ?? 'Imported project'),
        slug: `${String(ps.slug ?? 'project')}-${randomBytes(3).toString('hex')}`,
        about: String(ps.about ?? ''),
        aiConfig: String(ps.aiConfig ?? '{}'),
        chatRules: String(ps.chatRules ?? ''),
        storageLimit: (ps.storageLimit as string) ?? null,
      })
      .returning()
    bump('projects')
    const pid = project!.id

    for (const m of p.members) {
      const uid = await userFor(m)
      if (!uid) continue
      await db
        .insert(projectMembers)
        .values({
          projectId: pid,
          userId: uid,
          role: (m.role as 'member') ?? 'member',
          permissions: m.permissions ?? '{}',
          jobTitle: m.jobTitle ?? '',
          responsibility: m.responsibility ?? '',
        })
        .onConflictDoNothing()
      bump('projectMembers')
    }
    await db
      .insert(projectMembers)
      .values({ projectId: pid, userId: importerUserId, role: 'owner', permissions: '{}' })
      .onConflictDoNothing()

    // старый id → новый: связи внутри архива держатся на них
    const sprintIds = new Map<string, string>()
    const taskIds = new Map<string, string>()
    const commentIds = new Map<string, string>()
    const docIds = new Map<string, string>()
    const messageIds = new Map<string, string>()
    const resourceIds = new Map<string, string>()

    for (const s of p.sprints) {
      const [row] = await db
        .insert(taskGroups)
        .values({
          projectId: pid,
          name: String(s.name ?? ''),
          color: String(s.color ?? '#64748b'),
          sortOrder: Number(s.sortOrder ?? 0),
          createdById: await userFor(s.createdBy as PersonRef),
          deletedAt: s.deletedAt ? new Date(String(s.deletedAt)) : null,
        })
        .returning()
      sprintIds.set(String(s.id), row!.id)
      bump('sprints')
    }

    for (const t of p.tasks) {
      const [row] = await db
        .insert(tasks)
        .values({
          projectId: pid,
          groupId: t.groupId ? (sprintIds.get(String(t.groupId)) ?? null) : null,
          number: String(t.number ?? ''),
          title: String(t.title ?? ''),
          description: String(t.description ?? ''),
          status: (t.status as 'todo') ?? 'todo',
          priority: (t.priority as 'normal') ?? 'normal',
          estimateMinutes: (t.estimateMinutes as string) ?? null,
          sortOrder: Number(t.sortOrder ?? 0),
          dueDate: t.dueDate ? new Date(String(t.dueDate)) : null,
          assigneeId: await userFor(t.assignee as PersonRef),
          createdById: await userFor(t.createdBy as PersonRef),
          deletedAt: t.deletedAt ? new Date(String(t.deletedAt)) : null,
          createdAt: t.createdAt ? new Date(String(t.createdAt)) : undefined,
        })
        .returning()
      taskIds.set(String(t.id), row!.id)
      bump('tasks')
    }

    for (const cm of p.taskComments) {
      const taskId = taskIds.get(String(cm.taskId))
      if (!taskId) continue
      const [row] = await db
        .insert(taskComments)
        .values({
          taskId,
          projectId: pid,
          authorId: await userFor(cm.author as PersonRef),
          body: String(cm.body ?? ''),
          createdAt: cm.createdAt ? new Date(String(cm.createdAt)) : undefined,
        })
        .returning()
      commentIds.set(String(cm.id), row!.id)
      bump('taskComments')
    }

    for (const n of p.taskNotes) {
      const taskId = taskIds.get(String(n.taskId))
      if (!taskId) continue
      await db.insert(taskNotes).values({
        taskId,
        projectId: pid,
        kind: (n.kind as 'fact') ?? 'fact',
        body: String(n.body ?? ''),
      })
      bump('taskNotes')
    }

    for (const d of p.documents) {
      const [row] = await db
        .insert(documents)
        .values({
          projectId: pid,
          title: String(d.title ?? ''),
          content: String(d.content ?? ''),
          ycontent: null, // состояние co-editing не переносим: пересоздастся из HTML
          createdById: await userFor(d.createdBy as PersonRef),
          updatedById: await userFor(d.updatedBy as PersonRef),
          deletedAt: d.deletedAt ? new Date(String(d.deletedAt)) : null,
          createdAt: d.createdAt ? new Date(String(d.createdAt)) : undefined,
        })
        .returning()
      docIds.set(String(d.id), row!.id)
      bump('documents')
    }

    for (const v of p.documentVersions) {
      const documentId = docIds.get(String(v.documentId))
      if (!documentId) continue
      await db.insert(documentVersions).values({
        documentId,
        version: Number(v.version ?? 1),
        title: String(v.title ?? ''),
        content: String(v.content ?? ''),
        authorId: await userFor(v.author as PersonRef),
        note: String(v.note ?? ''),
      })
      bump('documentVersions')
    }

    for (const m of p.messages) {
      const [row] = await db
        .insert(messages)
        .values({
          projectId: pid,
          authorId: await userFor(m.author as PersonRef),
          mode: (m.mode as 'group') ?? 'group',
          status: (m.status as 'delivered') ?? 'delivered',
          rawSend: Boolean(m.rawSend),
          text: String(m.text ?? ''),
          systemEvent: (m.systemEvent as string) ?? null,
          createdAt: m.createdAt ? new Date(String(m.createdAt)) : undefined,
        })
        .returning()
      messageIds.set(String(m.id), row!.id)
      bump('messages')
    }

    // Журнал проекта (SPEC §8.31). Идёт после сообщений: цитаты ссылаются на них,
    // и только здесь messageIds уже знает соответствие старых id новым.
    for (const n of p.projectNotes ?? []) {
      const sources = (() => {
        try {
          const arr = JSON.parse(String(n.sources ?? '[]')) as { messageId?: string | null }[]
          // текст цитаты сохранён копией и переносится как есть; ссылку чиним,
          // а если сообщение не приехало — оставляем null, цитата всё равно читается
          return JSON.stringify(
            arr.map((src) => ({ ...src, messageId: src.messageId ? messageIds.get(String(src.messageId)) ?? null : null })),
          )
        } catch {
          return '[]'
        }
      })()

      await db.insert(projectNotes).values({
        projectId: pid,
        companyId: company!.id,
        type: String(n.type ?? 'note'),
        title: String(n.title ?? ''),
        body: String(n.body ?? ''),
        tags: String(n.tags ?? '[]'),
        scope: String(n.scope ?? 'project'),
        sources,
        // упоминания указывают на пользователей старой базы — не переносим,
        // иначе заметка «упомянет» случайных людей после сопоставления по email
        mentionedIds: '[]',
        remindAt: n.remindAt ? new Date(String(n.remindAt)) : null,
        remindedAt: n.remindedAt ? new Date(String(n.remindedAt)) : null,
        authorId: await userFor(n.author as PersonRef),
        createdVia: String(n.createdVia ?? 'ui'),
        deletedAt: n.deletedAt ? new Date(String(n.deletedAt)) : null,
        createdAt: n.createdAt ? new Date(String(n.createdAt)) : undefined,
      })
      bump('projectNotes')
    }

    // Учёт времени. Идёт после задач: запись может ссылаться на задачу, и
    // только здесь taskIds уже знает соответствие старых id новым.
    for (const e of p.timeEntries ?? []) {
      const userId = await userFor(e.user as PersonRef)
      if (!userId) continue // некому приписать часы — запись бессмысленна
      await db.insert(timeEntries).values({
        projectId: pid,
        userId,
        taskId: e.taskId ? taskIds.get(String(e.taskId)) ?? null : null,
        description: String(e.description ?? ''),
        startedAt: new Date(String(e.startedAt)),
        endedAt: e.endedAt ? new Date(String(e.endedAt)) : null,
        autoStopped: Boolean(e.autoStopped),
        createdVia: String(e.createdVia ?? 'ui'),
        createdAt: e.createdAt ? new Date(String(e.createdAt)) : undefined,
      })
      bump('timeEntries')
    }

    for (const s of p.chatSummaries) {
      await db.insert(chatSummaries).values({
        projectId: pid,
        name: String(s.name ?? ''),
        content: String(s.content ?? ''),
        messageCount: String(s.messageCount ?? '0'),
        fromAt: s.fromAt ? new Date(String(s.fromAt)) : new Date(),
        toAt: s.toAt ? new Date(String(s.toAt)) : new Date(),
      })
      bump('chatSummaries')
    }

    for (const r of p.resources) {
      const [row] = await db
        .insert(credentials)
        .values({
          projectId: pid,
          name: String(r.name ?? ''),
          url: (r.url as string) ?? null,
          description: String(r.description ?? ''),
          createdById: await userFor(r.createdBy as PersonRef),
          deletedAt: r.deletedAt ? new Date(String(r.deletedAt)) : null,
        })
        .returning()
      resourceIds.set(String(r.id), row!.id)
      bump('resources')
    }

    // Секреты: расшифровываем паролем владельца, шифруем ключом ЭТОЙ инсталляции
    if (p.resourceSecrets?.length) {
      if (!password) {
        warnings.push('Backup contains secrets but no password was provided — secrets were skipped')
      } else {
        for (const s of p.resourceSecrets) {
          const resourceId = resourceIds.get(String(s.resourceId))
          if (!resourceId) continue
          const packed = String(s.value ?? '')
          if (!packed) continue
          try {
            const plain = decryptWithPassword(packed, password)
            await db.insert(resourceSecrets).values({
              resourceId,
              label: String(s.label ?? ''),
              valueEncrypted: encrypt(plain),
            })
            bump('resourceSecrets')
          } catch {
            warnings.push('Could not decrypt a secret — wrong password?')
          }
        }
      }
    }

    // Метаданные файлов переносим, содержимое — нет: объекты лежат в хранилище,
    // и при импорте в другую инсталляцию их там не будет. Честно помечаем.
    let restoredFiles = 0
    for (const f of p.files) {
      await db.insert(files).values({
        projectId: pid,
        taskId: f.taskId ? (taskIds.get(String(f.taskId)) ?? null) : null,
        commentId: f.commentId ? (commentIds.get(String(f.commentId)) ?? null) : null,
        messageId: f.messageId ? (messageIds.get(String(f.messageId)) ?? null) : null,
        uploadedById: await userFor(f.uploadedBy as PersonRef),
        name: String(f.name ?? ''),
        key: String(f.key ?? ''),
        mime: String(f.mime ?? 'application/octet-stream'),
        size: String(f.size ?? '0'),
        originalKey: (f.originalKey as string) ?? null,
        deletedAt: f.deletedAt ? new Date(String(f.deletedAt)) : null,
        createdAt: f.createdAt ? new Date(String(f.createdAt)) : undefined,
      })
      restoredFiles++
      bump('files')
    }
    if (restoredFiles) {
      warnings.push(
        `${restoredFiles} file record(s) restored in "${project!.name}". File CONTENTS require the same storage bucket to be connected.`,
      )
    }
  }

  return { companyId: company!.id, created, warnings }
}
