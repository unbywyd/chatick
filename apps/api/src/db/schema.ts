import { pgTable, text, timestamp, boolean, uniqueIndex, index, pgEnum } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const id = () => text('id').primaryKey().$defaultFn(() => nanoid())
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())

// ---------------------------------------------------------------------------
// Users & auth
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name').notNull().default(''),
    phone: text('phone'), // для deep link «личное → WhatsApp»
    locale: text('locale').notNull().default('en'), // язык, на который ИИ переводит для юзера
    passwordHash: text('password_hash'),
    isAdmin: boolean('is_admin').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
)

// Персональные API-токены — для MCP-сервера и внешних агентов (Claude Code).
// Все действия через токен идут от имени владельца.
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: id(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // человекочитаемое: «Claude Code на рабочем ноуте»
    tokenHash: text('token_hash').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('api_tokens_user_idx').on(t.userId)],
)

// ---------------------------------------------------------------------------
// Projects (проект = группа = чат)
// ---------------------------------------------------------------------------

export const memberRole = pgEnum('member_role', ['owner', 'admin', 'member'])

export const projects = pgTable('projects', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  about: text('about').notNull().default(''), // таб «О проекте»
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const projectMembers = pgTable(
  'project_members',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: memberRole('role').notNull().default('member'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('project_members_uniq').on(t.projectId, t.userId),
    index('project_members_user_idx').on(t.userId),
  ],
)

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

// mode: 'group' — сообщение в группу (через ИИ-диспетчер),
//       'ai'    — личный диалог юзера с ИИ проекта
export const messageMode = pgEnum('message_mode', ['group', 'ai'])

// status пайплайна ИИ-диспетчера:
// visible сразу для автора (оптимистично), физически проходит через ИИ
export const messageStatus = pgEnum('message_status', [
  'pending', // ждёт обработки ИИ
  'delivered', // прошло, видно всем
  'held', // ИИ задал уточняющий вопрос автору
  'routed', // превращено в действие (обновление задачи и т.п.), в чат не пошло
])

export const messages = pgTable(
  'messages',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }), // null = сообщение от ИИ
    mode: messageMode('mode').notNull().default('group'),
    status: messageStatus('status').notNull().default('pending'),
    text: text('text').notNull(),
    // переводы: { "ru": "...", "he": "...", "en": "..." } — лениво заполняет ИИ
    translations: text('translations'), // JSON
    replyToId: text('reply_to_id'),
    createdAt: createdAt(),
  },
  (t) => [index('messages_project_created_idx').on(t.projectId, t.createdAt)],
)

// ---------------------------------------------------------------------------
// Tasks (минимальный таск-менеджер)
// ---------------------------------------------------------------------------

export const taskStatus = pgEnum('task_status', ['todo', 'in_progress', 'review', 'done'])

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    number: text('number').notNull(), // TASK-42 в рамках проекта
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: taskStatus('status').notNull().default('todo'),
    assigneeId: text('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('tasks_project_number_idx').on(t.projectId, t.number),
    index('tasks_project_status_idx').on(t.projectId, t.status),
  ],
)

// ---------------------------------------------------------------------------
// Files & credentials (табы проекта)
// ---------------------------------------------------------------------------

export const files = pgTable(
  'files',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    uploadedById: text('uploaded_by_id').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    key: text('key').notNull(), // S3 object key
    mime: text('mime').notNull().default('application/octet-stream'),
    size: text('size').notNull().default('0'),
    createdAt: createdAt(),
  },
  (t) => [index('files_project_idx').on(t.projectId)],
)

export const credentials = pgTable(
  'credentials',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // «Прод сервер SSH», «Админка WP»
    // значение шифруется на уровне приложения (AES-256-GCM), в БД — ciphertext
    valueEncrypted: text('value_encrypted').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('credentials_project_idx').on(t.projectId)],
)
