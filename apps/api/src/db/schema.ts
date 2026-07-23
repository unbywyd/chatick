import { pgTable, text, timestamp, boolean, uniqueIndex, index, pgEnum, doublePrecision } from 'drizzle-orm/pg-core'
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
    googleId: text('google_id'),
    avatarUrl: text('avatar_url'),
    isAdmin: boolean('is_admin').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email), uniqueIndex('users_google_idx').on(t.googleId)],
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
// Companies (компания — над проектами, SPEC.md §1-3)
// ---------------------------------------------------------------------------

export const companyRole = pgEnum('company_role', ['admin', 'manager', 'member'])

export const companies = pgTable('companies', {
  id: id(),
  name: text('name').notNull(),
  logoUrl: text('logo_url'),
  // BYO-LLM: компания подключает своего провайдера; ключ — AES-256-GCM, наружу не отдаётся
  llmProvider: text('llm_provider'), // anthropic | openai | google | deepseek | groq
  llmModel: text('llm_model'),
  llmKeyEncrypted: text('llm_key_encrypted'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const companyMembers = pgTable(
  'company_members',
  {
    id: id(),
    companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: companyRole('role').notNull().default('member'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('company_members_uniq').on(t.companyId, t.userId),
    index('company_members_user_idx').on(t.userId),
  ],
)

export const inviteStatus = pgEnum('invite_status', ['pending', 'accepted', 'revoked'])

// Приглашение в компанию — по email, с подтверждением (SPEC.md §3.1)
export const companyInvites = pgTable(
  'company_invites',
  {
    id: id(),
    companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: companyRole('role').notNull().default('member'),
    token: text('token').notNull().unique(),
    status: inviteStatus('status').notNull().default('pending'),
    invitedById: text('invited_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('company_invites_email_idx').on(t.email), index('company_invites_company_idx').on(t.companyId)],
)

// ---------------------------------------------------------------------------
// Projects (проект = группа = чат; принадлежит компании)
// ---------------------------------------------------------------------------

export const memberRole = pgEnum('member_role', ['owner', 'admin', 'member'])

export const projects = pgTable(
  'projects',
  {
    id: id(),
    companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    about: text('about').notNull().default(''), // таб «О проекте»
    // --- конфиг ИИ-диспетчера (SPEC.md §4.1) ---
    // структурированные флаги/проценты храним одним JSON-полем — состав будет расти
    aiConfig: text('ai_config').notNull().default('{}'), // JSON: { strictness, allowFlood, allowJokes, allowQuestions, allowOfftopic, filters: {...} }
    // --- текстовые правила чата (SPEC.md §4.2) ---
    // жёсткий лимит ~300 символов (валидация на API) — включается в каждый промпт ИИ
    chatRules: text('chat_rules').notNull().default(''),
    // курсор сжатия переписки (SPEC §5.6): сообщения старше — уже в саммари
    lastSummarizedAt: timestamp('last_summarized_at', { withTimezone: true }),
    // лимит хранилища проекта в байтах (дефолт 2 GB); настраивается owner/admin
    storageLimit: text('storage_limit').notNull().default(String(2 * 1024 * 1024 * 1024)),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('projects_company_idx').on(t.companyId)],
)

export const projectMembers = pgTable(
  'project_members',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: memberRole('role').notNull().default('member'),
    // per-user пермишены на задачи и пр. (SPEC.md §4.3); JSON: { "tasks.create": true, ... }
    permissions: text('permissions').notNull().default('{}'),
    // подтверждение правил чата перед вступлением (SPEC.md §4.2)
    rulesAcceptedAt: timestamp('rules_accepted_at', { withTimezone: true }),
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
    // отправлено в обход/вопреки ИИ — в ленте помечается «без проверки»
    rawSend: boolean('raw_send').notNull().default(false),
    // ai-режим приватен: ответ ИИ адресован конкретному юзеру
    recipientId: text('recipient_id').references(() => users.id, { onDelete: 'cascade' }),
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
export const taskPriority = pgEnum('task_priority', ['low', 'normal', 'high', 'urgent'])

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    number: text('number').notNull(), // TASK-42 в рамках проекта
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: taskStatus('status').notNull().default('todo'),
    priority: taskPriority('priority').notNull().default('normal'),
    // ручной порядок внутри статус-группы (drag&drop); меньше = выше
    sortOrder: doublePrecision('sort_order').notNull().default(0),
    dueDate: timestamp('due_date', { withTimezone: true }),
    assigneeId: text('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('tasks_project_number_idx').on(t.projectId, t.number),
    index('tasks_project_status_idx').on(t.projectId, t.status),
    index('tasks_assignee_idx').on(t.assigneeId),
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
    // вложение задачи: файл прикреплён прямо в таске (null = общий файл проекта)
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    // вложение сообщения чата (SPEC §5.5.4)
    messageId: text('message_id').references(() => messages.id, { onDelete: 'set null' }),
    // картинки оптимизируются (webp); оригинал сохраняется отдельным ключом, если просили
    originalKey: text('original_key'),
    uploadedById: text('uploaded_by_id').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    key: text('key').notNull(), // S3 object key
    mime: text('mime').notNull().default('application/octet-stream'),
    size: text('size').notNull().default('0'),
    createdAt: createdAt(),
  },
  (t) => [
    index('files_project_idx').on(t.projectId),
    index('files_task_idx').on(t.taskId),
    index('files_message_idx').on(t.messageId),
  ],
)

// Саммари бесед (SPEC §5.6): переписка сжимается кусками; имя генерит ИИ.
// Сырые сообщения не удаляются — по ним работает search_messages.
export const chatSummaries = pgTable(
  'chat_summaries',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // короткое ИИ-имя беседы: «Обсуждение деплоя API»
    content: text('content').notNull(), // полное саммари
    fromAt: timestamp('from_at', { withTimezone: true }).notNull(),
    toAt: timestamp('to_at', { withTimezone: true }).notNull(),
    messageCount: text('message_count').notNull().default('0'),
    createdAt: createdAt(),
  },
  (t) => [index('chat_summaries_project_idx').on(t.projectId, t.toAt)],
)

// Sandbox — приватный диалог автора с ИИ вокруг held-сообщения (SPEC §5.5.3).
// role: user | ai; suggestion=true — ИИ предложил вариант; approved=true — годен к отправке («Выбрать»)
export const sandboxRole = pgEnum('sandbox_role', ['user', 'ai'])

export const sandboxMessages = pgTable(
  'sandbox_messages',
  {
    id: id(),
    messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    role: sandboxRole('role').notNull(),
    text: text('text').notNull(),
    suggestion: boolean('suggestion').notNull().default(false),
    approved: boolean('approved').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('sandbox_message_idx').on(t.messageId, t.createdAt)],
)

export const credentials = pgTable(
  'credentials',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // «Прод сервер SSH», «Админка WP»
    // значение шифруется на уровне приложения (AES-256-GCM), в БД — ciphertext
    valueEncrypted: text('value_encrypted').notNull(),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('credentials_project_idx').on(t.projectId)],
)

// Аудит доступа к кредишенам: кто/когда раскрывал, создавал, менял, удалял.
// Значения сюда НИКОГДА не пишутся.
export const credentialActions = pgEnum('credential_action', ['reveal', 'create', 'update', 'delete'])

export const credentialAccessLog = pgTable(
  'credential_access_log',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id'), // без FK: лог живёт и после удаления креда
    credentialName: text('credential_name').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: credentialActions('action').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('cred_log_project_created_idx').on(t.projectId, t.createdAt)],
)
