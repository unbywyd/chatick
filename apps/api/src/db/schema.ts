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
    avatarKey: text('avatar_key'), // S3-ключ загруженного аватара (раздаётся через /auth/avatar/:id)
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
  // Лимиты уровня компании (задел под подписки; настраиваются через БД). 0 = без лимита.
  storageLimit: text('storage_limit').notNull().default(String(5 * 1024 * 1024 * 1024)), // общий пул хранилища
  maxProjects: text('max_projects').notNull().default('0'), // 0 = без лимита
  maxMembers: text('max_members').notNull().default('0'),
  plan: text('plan').notNull().default('free'), // ярлык тарифа (для будущего биллинга)
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
    // override лимита хранилища проекта в байтах; NULL = наследует пул компании (SPEC §7)
    storageLimit: text('storage_limit'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('projects_company_idx').on(t.companyId)],
)

// Настройка хранилища проекта (SPEC §8.10): platform (наш, лимит) | custom (свой S3/R2, без лимита).
// Ключи шифруются (AES-256-GCM), в ответах API — только метаданные.
export const storageProvider = pgEnum('storage_provider', ['platform', 'custom'])

export const projectStorage = pgTable(
  'project_storage',
  {
    projectId: text('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
    provider: storageProvider('provider').notNull().default('platform'),
    endpoint: text('endpoint'), // https://<account>.r2.cloudflarestorage.com
    region: text('region').notNull().default('auto'),
    bucket: text('bucket'),
    accessKeyEncrypted: text('access_key_encrypted'),
    secretKeyEncrypted: text('secret_key_encrypted'),
    publicUrl: text('public_url'), // опциональный CDN/public base
    updatedAt: updatedAt(),
  },
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
    // должность и зона ответственности (SPEC §8.12) — короткий текст, опрокидывается в контекст ИИ
    jobTitle: text('job_title').notNull().default(''),
    responsibility: text('responsibility').notNull().default(''),
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
    // прикреплённые задачи (пины) — JSON массив id задач
    taskRefs: text('task_refs'),
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

// Группы задач = спринты (SPEC §8.6): имя + цвет, ручной порядок групп.
export const taskGroups = pgTable(
  'task_groups',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#64748b'), // hex
    sortOrder: doublePrecision('sort_order').notNull().default(0),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedById: text('deleted_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('task_groups_project_idx').on(t.projectId, t.sortOrder)],
)

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    // группа/спринт (null = без группы); при удалении группы задачи остаются без группы
    groupId: text('group_id').references(() => taskGroups.id, { onDelete: 'set null' }),
    number: text('number').notNull(), // TASK-42 в рамках проекта
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: taskStatus('status').notNull().default('todo'),
    priority: taskPriority('priority').notNull().default('normal'),
    // оценка времени на выполнение в минутах (SPEC §8.13); null = не задана
    estimateMinutes: text('estimate_minutes'),
    // ручной порядок внутри статус-группы (drag&drop); меньше = выше
    sortOrder: doublePrecision('sort_order').notNull().default(0),
    dueDate: timestamp('due_date', { withTimezone: true }),
    assigneeId: text('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    // soft-delete (SPEC §8.21): восстановимо 7 дней, потом крон удаляет окончательно
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedById: text('deleted_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('tasks_project_number_idx').on(t.projectId, t.number),
    index('tasks_project_status_idx').on(t.projectId, t.status),
    index('tasks_assignee_idx').on(t.assigneeId),
    index('tasks_group_idx').on(t.groupId),
    index('tasks_deleted_idx').on(t.deletedAt),
  ],
)

// Комментарии к задачам (SPEC §8.9): минимальный Tiptap + mentions + ответы + файлы.
export const taskComments = pgTable(
  'task_comments',
  {
    id: id(),
    taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(), // markdown с mention-разметкой @[label](id)
    replyToId: text('reply_to_id'), // ответ на другой комментарий (без FK — переживает удаление)
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('task_comments_task_idx').on(t.taskId, t.createdAt)],
)

// Заметки ИИ к задаче (SPEC §8.14): факт / проблема / рекомендация / опровержение.
// Тело — markdown, генерируется ИИ при создании задачи (если включено generateTaskNotes).
export const taskNoteKind = pgEnum('task_note_kind', ['fact', 'issue', 'recommendation', 'rebuttal'])

export const taskNotes = pgTable(
  'task_notes',
  {
    id: id(),
    taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    kind: taskNoteKind('kind').notNull(),
    body: text('body').notNull(), // markdown
    createdAt: createdAt(),
  },
  (t) => [index('task_notes_task_idx').on(t.taskId, t.createdAt)],
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
    // вложение комментария задачи: файл привязан к комментарию (и к задаче через taskId)
    commentId: text('comment_id').references(() => taskComments.id, { onDelete: 'set null' }),
    // вложение сообщения чата (SPEC §5.5.4)
    messageId: text('message_id').references(() => messages.id, { onDelete: 'set null' }),
    // картинки оптимизируются (webp); оригинал сохраняется отдельным ключом, если просили
    originalKey: text('original_key'),
    uploadedById: text('uploaded_by_id').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    key: text('key').notNull(), // S3 object key
    mime: text('mime').notNull().default('application/octet-stream'),
    size: text('size').notNull().default('0'),
    // soft-delete: файл убран из менеджера, но в чате остаётся «файл удалён»
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedById: text('deleted_by_id').references(() => users.id, { onDelete: 'set null' }),
    // временный файл: загружен в композер, но сообщение/комментарий ещё не отправлены.
    // Не виден в менеджере; если до этого времени не привязан — удаляется кроном (SPEC §8.17).
    pendingUntil: timestamp('pending_until', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('files_project_idx').on(t.projectId),
    index('files_task_idx').on(t.taskId),
    index('files_message_idx').on(t.messageId),
    index('files_pending_idx').on(t.pendingUntil),
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

// Ресурс (SPEC §8.1): опциональная ссылка + описание + под ним опциональные секреты.
// (таблица исторически credentials — переименована логически в «Ресурсы»)
export const resourceSource = pgEnum('resource_source', ['manual', 'chat'])

export const credentials = pgTable(
  'credentials',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // «Прод сервер SSH», «Дизайн в Figma»
    url: text('url'), // опциональная ссылка
    description: text('description').notNull().default(''),
    // legacy single-value (миграция старых кредов в первый секрет); новые — в resource_secrets
    valueEncrypted: text('value_encrypted'),
    source: resourceSource('source').notNull().default('manual'),
    messageId: text('message_id'), // связь на сообщение, если из чата (без FK — переживает удаление)
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedById: text('deleted_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('credentials_project_idx').on(t.projectId)],
)

// Секреты под ресурсом (много): label + шифрованное значение
export const resourceSecrets = pgTable(
  'resource_secrets',
  {
    id: id(),
    resourceId: text('resource_id').notNull().references(() => credentials.id, { onDelete: 'cascade' }),
    label: text('label').notNull().default(''), // «Пароль», «API key»
    valueEncrypted: text('value_encrypted').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('resource_secrets_idx').on(t.resourceId)],
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

// Универсальный журнал действий (SPEC §8.21): кто/что/когда по всем сущностям.
// Хранится ВЕЧНО. entityType: task | file | resource | comment | sprint | member | project | ai...
export const activityAction = pgEnum('activity_action', ['create', 'update', 'delete', 'restore', 'status', 'assign', 'comment', 'upload'])

export const activityLog = pgTable(
  'activity_log',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }), // null = ИИ/система
    action: activityAction('action').notNull(),
    entityType: text('entity_type').notNull(), // task | file | resource | comment | sprint | member | ...
    entityId: text('entity_id'), // без FK: лог переживает удаление сущности
    entityLabel: text('entity_label').notNull().default(''), // человекочитаемо: «TASK-42: Deploy API»
    meta: text('meta'), // JSON: доп. детали (что изменилось и т.п.)
    createdAt: createdAt(),
  },
  (t) => [
    index('activity_project_created_idx').on(t.projectId, t.createdAt),
    index('activity_entity_idx').on(t.entityType, t.entityId),
  ],
)

// ---------------------------------------------------------------------------
// Notifications (SPEC §8.9) — email при упоминании / назначении задачи и пр.
// ---------------------------------------------------------------------------

// Типы событий, на которые можно подписаться/отписаться (per-project, per-user).
export const notificationEvent = pgEnum('notification_event', [
  'chat_mention', // тебя упомянули в чате
  'task_mention', // упомянули в описании задачи
  'comment_mention', // упомянули в комментарии
  'task_assigned', // тебе назначили задачу
  'task_status', // изменился статус твоей/назначенной задачи
  'task_comment', // новый комментарий к задаче, где ты автор/ассайни
])

// Подписки: строка = (user, project, event) отключён. По умолчанию всё включено;
// запись появляется ТОЛЬКО когда пользователь отписался — так дефолт = «включено».
export const notificationOptOuts = pgTable(
  'notification_opt_outs',
  {
    id: id(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    event: notificationEvent('event').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('notif_optout_idx').on(t.userId, t.projectId, t.event)],
)

// ГЛОБАЛЬНЫЕ in-app уведомления (SPEC §8.22): основной канал вместо мгновенных писем.
// Пользователь видит уведомления из ВСЕХ своих проектов; группировка по проекту — на клиенте.
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    event: notificationEvent('event').notNull(),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }), // null = ИИ/система
    title: text('title').notNull(), // «Artyom упомянул вас»
    body: text('body').notNull().default(''), // превью текста
    // куда вести по клику: относительный путь внутри приложения (/p/<id>/tasks/<taskId> и т.п.)
    link: text('link').notNull().default(''),
    entityType: text('entity_type'), // task | message | comment
    entityId: text('entity_id'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('notifications_user_read_idx').on(t.userId, t.readAt),
    index('notifications_user_created_idx').on(t.userId, t.createdAt),
  ],
)

// Персональные настройки уведомлений (глобальные, per-user).
export const userNotificationPrefs = pgTable('user_notification_prefs', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  // суточный email-дайджест непрочитанных (вместо мгновенных писем)
  dailyDigest: boolean('daily_digest').notNull().default(true),
  digestHourUtc: text('digest_hour_utc').notNull().default('9'),
  lastDigestAt: timestamp('last_digest_at', { withTimezone: true }),
  updatedAt: updatedAt(),
})

// Лог отправленных уведомлений — для дедупа (не слать одно и то же дважды).
export const notificationLog = pgTable(
  'notification_log',
  {
    id: id(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    event: notificationEvent('event').notNull(),
    // ключ дедупа: например `${event}:${messageId}:${userId}`
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('notif_log_dedupe_idx').on(t.dedupeKey)],
)

// ---------------------------------------------------------------------------
// ИИ-агент проекта + учёт использования (SPEC §8.11)
// ---------------------------------------------------------------------------

// Источник ИИ проекта: trial (наш пробный, бюджет $2) | custom (свой ключ) | company (ключ компании, дефолт).
export const aiSource = pgEnum('ai_source', ['company', 'trial', 'custom'])

export const projectAi = pgTable(
  'project_ai',
  {
    projectId: text('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
    source: aiSource('source').notNull().default('company'),
    // custom: свой провайдер/модель/ключ (ключ шифрован)
    provider: text('provider'),
    model: text('model'),
    keyEncrypted: text('key_encrypted'),
    updatedAt: updatedAt(),
  },
)

// Лог использования ИИ: по каждому вызову — модель, токены, стоимость (в центах, 6 знаков).
export const aiUsageLog = pgTable(
  'ai_usage_log',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    source: aiSource('source').notNull(),
    model: text('model').notNull(),
    tokensIn: text('tokens_in').notNull().default('0'),
    tokensOut: text('tokens_out').notNull().default('0'),
    // стоимость в USD (строкой, чтобы не терять точность); null = цена модели неизвестна
    costUsd: text('cost_usd'),
    feature: text('feature'), // dispatcher | chat | summary | improve_task | validate_task
    createdAt: createdAt(),
  },
  (t) => [index('ai_usage_project_idx').on(t.projectId, t.createdAt)],
)

// Прайсинг моделей: цена за 1M токенов (USD). Глобальный дефолт (projectId=null) +
// per-project override. Известные модели — сидятся; для неизвестных цены нет, пока не зададут.
export const modelPricing = pgTable(
  'model_pricing',
  {
    id: id(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }), // null = глобальный дефолт
    model: text('model').notNull(),
    inputPerM: text('input_per_m').notNull(), // USD за 1M входящих токенов
    outputPerM: text('output_per_m').notNull(), // USD за 1M исходящих
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('model_pricing_idx').on(t.projectId, t.model)],
)

// Напоминания о задачах в TODO (SPEC §8.9): per-project таймер → письмо со списком.
export const reminderCadence = pgEnum('reminder_cadence', ['hourly', 'daily', 'weekly'])
// Кому слать список открытых задач.
export const reminderAudience = pgEnum('reminder_audience', ['all_members', 'assignees'])

export const taskReminders = pgTable(
  'task_reminders',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    cadence: reminderCadence('cadence').notNull().default('daily'),
    // hourly: каждые N часов; daily/weekly: в hourOfDay (UTC)
    everyHours: text('every_hours').notNull().default('3'),
    hourOfDay: text('hour_of_day').notNull().default('9'), // 0..23 UTC
    dayOfWeek: text('day_of_week').notNull().default('1'), // weekly: 0=вс..6=сб
    audience: reminderAudience('audience').notNull().default('all_members'),
    // какие статусы считать «открытыми» — CSV из task_status; по умолчанию только todo
    statuses: text('statuses').notNull().default('todo'),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('task_reminders_project_idx').on(t.projectId)],
)
