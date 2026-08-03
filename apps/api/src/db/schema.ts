import { pgTable, text, timestamp, boolean, uniqueIndex, index, integer, pgEnum, doublePrecision } from 'drizzle-orm/pg-core'
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
    // Идентификатор человека во внешней системе. По нему узнаём его при
    // повторном вызове API и не заводим дубль.
    externalId: text('external_id'),
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

/**
 * Ключи API уровня КОМПАНИИ (SPEC-INTEGRATION §2).
 *
 * apiTokens выше привязаны к человеку и умирают вместе с его увольнением.
 * Интеграция принадлежит компании, а не сотруднику, который её настроил.
 */
export const companyApiKeys = pgTable(
  'company_api_keys',
  {
    id: id(),
    companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // «Atlas, продакшн» — чтобы понимать, что отзываешь
    keyHash: text('key_hash').notNull(), // сам ключ не хранится
    prefix: text('prefix').notNull(), // первые знаки — показать в списке
    scopes: text('scopes').notNull().default('[]'), // users:write, projects:write, read:all
    allowedIps: text('allowed_ips').notNull().default('[]'), // пусто = отовсюду
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }), // отзыв мгновенный
    createdAt: createdAt(),
  },
  (t) => [index('company_api_keys_company_idx').on(t.companyId), uniqueIndex('company_api_keys_hash_idx').on(t.keyHash)],
)

/** Журнал вызовов извне: ключ компании даёт много, поэтому видно, кто и что делал. */
export const companyApiLog = pgTable(
  'company_api_log',
  {
    id: id(),
    companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    keyId: text('key_id').references(() => companyApiKeys.id, { onDelete: 'set null' }),
    method: text('method').notNull(),
    path: text('path').notNull(),
    status: integer('status').notNull(),
    ip: text('ip').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('company_api_log_company_idx').on(t.companyId, t.createdAt)],
)

// ---------------------------------------------------------------------------
// Companies (компания — над проектами, SPEC.md §1-3)
// ---------------------------------------------------------------------------

export const companyRole = pgEnum('company_role', ['admin', 'manager', 'member'])

/**
 * Бесплатный пул хранилища на компанию (SPEC §7).
 *
 * Считается только для платформенного хранилища: подключил своё R2 — платишь
 * за него сам, и ограничивать там нечего.
 */
export const FREE_STORAGE_BYTES = 2 * 1024 * 1024 * 1024

export const companies = pgTable('companies', {
  id: id(),
  name: text('name').notNull(),
  logoUrl: text('logo_url'),
  // BYO-LLM: компания подключает своего провайдера; ключ — AES-256-GCM, наружу не отдаётся
  llmProvider: text('llm_provider'), // anthropic | openai | google | deepseek | groq
  llmModel: text('llm_model'),
  llmKeyEncrypted: text('llm_key_encrypted'),
  // Лимиты уровня компании (задел под подписки; настраиваются через БД). 0 = без лимита.
  storageLimit: text('storage_limit').notNull().default(String(FREE_STORAGE_BYTES)), // общий пул хранилища
  maxProjects: text('max_projects').notNull().default('0'), // 0 = без лимита
  maxMembers: text('max_members').notNull().default('0'),
  plan: text('plan').notNull().default('free'), // ярлык тарифа (для будущего биллинга)
  // Демо-компания: заводится сидом, сносится одной командой. Явный признак,
  // а не имя — переименованную компанию скрипт очистки уже не нашёл бы.
  isDemo: boolean('is_demo').notNull().default(false),
  // Язык компании: на нём пишутся письма тем, у кого своих настроек ещё нет —
  // например, человеку, которого только что завели через API.
  locale: text('locale').notNull().default('en'),
  // --- связь с внешней системой (SPEC-INTEGRATION) ---
  // Название и шаблон ссылки — настройки, а не код: так интеграция остаётся
  // универсальной, без следов конкретного заказчика.
  externalSystemName: text('external_system_name'),
  externalProjectUrl: text('external_project_url'), // https://…/projects/{externalId}
  // Проекты приходят только через API — кнопка создания в интерфейсе исчезает.
  projectsViaApiOnly: boolean('projects_via_api_only').notNull().default(false),
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
    // Куда добавить сразу после принятия. Пригласить нового человека прямо в
    // проект нельзя — учётной записи ещё нет, а участник проекта ссылается на
    // пользователя. Поэтому запоминаем намерение здесь и исполняем его, когда
    // человек примет приглашение и станет существовать.
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
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
    // Опознавательные знаки проекта: в свёрнутом сайдбаре видно только их.
    // Цвет раздаётся случайно при создании — чтобы проекты различались сразу,
    // без похода в настройки.
    color: text('color').notNull().default('#6366f1'),
    // Трекинг и региональные настройки (SPEC §8.32). JSON — состав растёт.
    // { maxTimers, idleAction: 'remind'|'stop', idleHours, repeatHours,
    //   country, timezone, weekStart: 0..6 }
    // Пояс и первый день недели нужны, чтобы «эта неделя» и суммы за день
    // считались одинаково у всех: иначе клиент режет дни по своему поясу,
    // а SQL — по серверному, и понедельник у них разный.
    timeConfig: text('time_config').notNull().default('{}'),
    logoUrl: text('logo_url'),
    logoKey: text('logo_key'),
    // Идентификатор и имя проекта в системе заказчика. Имя показывается рядом
    // с нашим: он зовёт проект по клиенту, мы — по сути работы.
    externalId: text('external_id'),
    externalName: text('external_name'),
    // NULL = наследовать от компании. Отдельное значение от 'en': иначе не
    // отличить «выбрали английский» от «не выбирали».
    locale: text('locale'),
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
    // системное автосообщение о событии задачи (SPEC §8.23): task_done | task_assigned
    systemEvent: text('system_event'),
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

/**
 * Чек-лист задачи (SPEC §8.37).
 *
 * Задача часто не одно действие, а список: пройтись и отметить. К пункту
 * иногда нужен ответ, но чаще нет — поэтому заметка необязательна.
 *
 * Галочки ставятся только руками: ответить и счесть сделанным — разные
 * решения. Права те же, что у самой задачи: чек-лист её часть, а не
 * отдельная сущность со своим доступом.
 */
export const taskChecklist = pgTable(
  'task_checklist',
  {
    id: id(),
    taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    /** Ответ или заметка под пунктом; пусто — обычное дело. */
    note: text('note').notNull().default(''),
    done: boolean('done').notNull().default(false),
    // Кто закрыл — первое, что спрашивают в задаче на несколько человек.
    doneById: text('done_by_id').references(() => users.id, { onDelete: 'set null' }),
    doneAt: timestamp('done_at', { withTimezone: true }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('task_checklist_task_idx').on(t.taskId, t.sortOrder)],
)

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

// Документы проекта (SPEC §8.24): богатый текст (Tiptap/markdown), публичный доступ
// по ссылке, ЛЛМ читает/пишет их (длинные — частями).
export const documents = pgTable(
  'documents',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    content: text('content').notNull().default(''), // HTML-снимок (версии, /d/:slug, ИИ, экспорт)
    // Состояние Yjs — источник правды для редактора при совместной работе (SPEC §8.25 шаг 2).
    // HTML в content обновляется снимком при сохранении, чтобы всё остальное работало как раньше.
    ycontent: text('ycontent'), // base64 Y.encodeStateAsUpdate
    // публичный доступ по ссылке: null = выключен
    publicSlug: text('public_slug').unique(),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: text('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedById: text('deleted_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('documents_project_idx').on(t.projectId, t.updatedAt)],
)

/**
 * Заметки проекта (SPEC §8.31) — журнал знания и свидетельств.
 *
 * Два сценария в одной сущности:
 *   решение — «проблема с DNS решается так»: ищется по симптому, живёт долго,
 *     ценно в ДРУГИХ проектах, поэтому scope='company' достаёт его отовсюду;
 *   противоречие — «сказали это, потом то, потом обвинили»: ценно только внутри
 *     проекта, и вся его сила в цепочке sources.
 *
 * Заводятся вручную (человеком или ЛЛМ по просьбе), не автоматически.
 */
export const notes = pgTable(
  'notes',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    // дублируем компанию проекта: поиск scope='company' идёт по ней без джойна
    companyId: text('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    // тип задаёт иконку и цвет; теги — свободные, поверх типа
    type: text('type').notNull().default('note'), // note|solution|problem|decision|contradiction|reminder|business
    title: text('title').notNull().default(''),
    body: text('body').notNull().default(''), // HTML, как в документах
    tags: text('tags').notNull().default('[]'), // JSON string[]
    // 'project' — видна в своём проекте; 'company' — находится из любого проекта компании
    scope: text('scope').notNull().default('project'),
    /**
     * Источники: JSON-массив {messageId?, text, authorName?, sentAt?}.
     * Пусто, когда заметку сохранили из редактора — туда чат не приходит.
     * text хранится КОПИЕЙ: доказательство должно пережить удаление сообщения.
     */
    sources: text('sources').notNull().default('[]'),
    mentionedIds: text('mentioned_ids').notNull().default('[]'), // JSON string[] — кого касается
    // Задача, выросшая из заметки: заметка остаётся и объясняет, ПОЧЕМУ задача
    // такая, а задача — что с этим делают. Обе стороны знают друг о друге.
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    // напоминание: заметка всплывает в уведомлениях в эту дату
    remindAt: timestamp('remind_at', { withTimezone: true }),
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    // заметку мог сохранить ЛЛМ от имени человека — видно, чьей рукой
    createdVia: text('created_via').notNull().default('ui'), // ui|bridge|ai
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedById: text('deleted_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('notes_project_idx').on(t.projectId, t.createdAt),
    index('notes_company_idx').on(t.companyId, t.scope),
    index('notes_remind_idx').on(t.remindAt),
  ],
)

/**
 * Записи трекера времени (SPEC §8.32).
 *
 * Одна запись — один отрезок работы одного человека. Задача необязательна:
 * типичный сценарий — запустил утром и работаешь весь день, ничего не указывая.
 * Задача ОДНА, а не список: час на трёх задачах пришлось бы либо делить
 * выдуманными долями, либо считать трижды. Нужно две задачи разом — запускаются
 * два таймера (их число ограничивает настройка проекта).
 *
 * endedAt = null означает «идёт сейчас».
 */
export const timeEntries = pgTable(
  'time_entries',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    description: text('description').notNull().default(''),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }), // null = таймер идёт
    // Остановлен автоматически по порогу забытого таймера — видно и человеку,
    // и статистике, что это не его решение.
    autoStopped: boolean('auto_stopped').notNull().default(false),
    // сколько раз уже напомнили — чтобы повтор шёл по расписанию, а не каждый тик
    remindersSent: integer('reminders_sent').notNull().default(0),
    createdVia: text('created_via').notNull().default('ui'), // ui | bridge | ai
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('time_entries_project_idx').on(t.projectId, t.startedAt),
    index('time_entries_user_idx').on(t.userId, t.startedAt),
    // быстрый поиск идущих таймеров: их мало, но ищут их постоянно
    index('time_entries_running_idx').on(t.userId, t.endedAt),
  ],
)

// Версии документа (SPEC §8.25): снапшот контента, история и откат.
// Пишется не на каждое автосохранение, а при существенном изменении/паузе — см. routes/documents.ts.
export const documentVersions = pgTable(
  'document_versions',
  {
    id: id(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(), // порядковый номер внутри документа, с 1
    title: text('title').notNull().default(''),
    content: text('content').notNull().default(''),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    // помечает снапшот, созданный автоматически перед откатом (чтобы откат тоже был обратим)
    note: text('note').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('document_versions_doc_idx').on(t.documentId, t.version)],
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
    // Имя необязательно: ресурс — это чаще всего ссылка, а название ей
    // придумывают редко. Пусто — подставим домен.
    name: text('name').notNull().default(''), // «Прод сервер SSH», «Дизайн в Figma»
    url: text('url'), // опциональная ссылка
    icon: text('icon'), // og:image или favicon как data-URI — узнавать ссылку глазами
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
  'note_mention', // тебя упомянули в заметке проекта
  'note_reminder', // наступила дата напоминания в заметке
  'timer_running', // таймер идёт слишком долго — не забыли ли выключить
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
    // Суть запроса словами ИИ: «просит прислать APK последней сборки».
    // Заполняется асинхронно после создания — уведомление не ждёт модель.
    summary: text('summary'),
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
    // Пробный по умолчанию: у нового проекта ключа компании ещё нет
    source: aiSource('source').notNull().default('trial'),
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

// ---------------------------------------------------------------------------
// Мост для внешнего ИИ (Claude Code) — SPEC §8.27
// ---------------------------------------------------------------------------

// Одноразовый код авторизации (device flow, как у gh/heroku/vercel).
// ИИ получает код, человек подтверждает его в браузере — токен НЕ проходит
// через историю команд. Код живёт минуты и сгорает при первом обмене.
export const bridgeAuthCodes = pgTable(
  'bridge_auth_codes',
  {
    id: id(),
    // короткий код, который ИИ показывает человеку (WXYZ-1234)
    userCode: text('user_code').notNull().unique(),
    // длинный секрет, по которому ИИ опрашивает статус — человеку не показывается
    deviceCode: text('device_code').notNull().unique(),
    status: text('status').notNull().default('pending'), // pending | approved | denied
    // заполняются в момент подтверждения человеком; область — проект ЛИБО компания
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    companyId: text('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    // мастер-доступ: все проекты человека во всех его компаниях
    scopeAll: boolean('scope_all').notNull().default(false),
    // как ИИ представился — показываем человеку, чтобы он понимал, что одобряет
    clientName: text('client_name').notNull().default('AI assistant'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('bridge_auth_codes_expiry_idx').on(t.expiresAt)],
)

// Открытый туннель = живой токен. Закрыли туннель — токен мёртв.
// Постоянных токенов в системе нет: утёкшая строка бесполезна после закрытия.
export const bridgeSessions = pgTable(
  'bridge_sessions',
  {
    id: id(),
    // хэш токена, не сам токен: утечка дампа БД не даёт доступа
    tokenHash: text('token_hash').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Область действия туннеля. Либо один проект, либо вся компания:
    // менеджеру нужен доступ ко всем её проектам, а не к одному (SPEC §8.27).
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    companyId: text('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    // мастер-доступ: ни проект, ни компания не заданы — открыты все проекты
    // человека. Отдельным признаком, а не пустотой полей: пустота уже значит
    // «не подтверждено».
    scopeAll: boolean('scope_all').notNull().default(false),
    clientName: text('client_name').notNull().default('AI assistant'),
    // туннель сам закрывается после простоя — забытая сессия не живёт вечно
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('bridge_sessions_user_idx').on(t.userId, t.revokedAt)],
)

// --- Общий доступ по ссылке (SPEC §8.34) ------------------------------------
//
// Одна таблица на все сущности вместо колонки в каждой: типов уже пять, и
// заводить публичный slug отдельно в файлах, документах, заметках, ресурсах и
// сообщениях означало бы пять раз написать одно и то же — и пять раз забыть
// про отзыв доступа.
//
// Приватная ссылка (scope='project') не создаёт записи вовсе: это просто адрес
// внутри приложения, доступ по нему решают обычные права. Запись нужна только
// для публичного доступа — того, что работает без входа.

export const shareEntity = pgEnum('share_entity', ['file', 'document', 'note', 'resource', 'message', 'task'])

export const shares = pgTable(
  'shares',
  {
    id: id(),
    // Короткая ссылка живёт отдельно от id сущности: по ней нельзя угадать,
    // что ещё есть в проекте, а отзыв доступа не ломает саму сущность.
    slug: text('slug').notNull().unique(),
    entityType: shareEntity('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    // Проект нужен для прав и для зачистки: удалили проект — ссылки умерли.
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    // Срок жизни: null = бессрочно. Ссылку на черновик логично выдать на неделю.
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // Сколько раз открывали — чтобы понимать, ушла ли ссылка дальше адресата.
    views: text('views').notNull().default('0'),
    createdAt: createdAt(),
  },
  (t) => [
    // Одна активная ссылка на сущность: вторая означала бы, что отзыв первой
    // ничего не даёт.
    index('shares_entity_idx').on(t.entityType, t.entityId),
    index('shares_project_idx').on(t.projectId),
  ],
)

// --- Обратная связь и настройки площадки (SPEC §8.35) -----------------------

export const feedbackTopic = pgEnum('feedback_topic', ['question', 'bug', 'feature', 'billing', 'other'])
export const feedbackStatus = pgEnum('feedback_status', ['new', 'read', 'answered'])

/**
 * Обращения из формы «Связаться с нами».
 *
 * Пишем и от вошедших, и от посторонних: вопрос может быть у того, кто ещё не
 * завёл аккаунт. Для вошедшего сохраняем связь с пользователем — иначе потом
 * не понять, о ком речь, а переписка по почте это не восстановит.
 */
export const feedback = pgTable(
  'feedback',
  {
    id: id(),
    topic: feedbackTopic('topic').notNull().default('question'),
    body: text('body').notNull(),
    // Имя и почта хранятся отдельно от пользователя: он мог их сменить, а
    // обращение должно помнить, как с ним связывались тогда.
    email: text('email').notNull(),
    name: text('name').notNull().default(''),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    status: feedbackStatus('status').notNull().default('new'),
    // Откуда пришли и с чего: помогает воспроизвести жалобу на интерфейс.
    meta: text('meta'),
    // Скриншот в хранилище платформы. Один снимок экрана заменяет три письма
    // с уточнениями, поэтому прикладывать его стоит поощрять.
    screenshotKey: text('screenshot_key'),
    createdAt: createdAt(),
  },
  (t) => [index('feedback_status_idx').on(t.status, t.createdAt)],
)

export const reviewStatus = pgEnum('review_status', ['pending', 'published', 'rejected'])

/**
 * Отзывы с сайта (SPEC §8.37).
 *
 * Появляются на сайте только после одобрения: отзыв виден всем, и пускать туда
 * что угодно без просмотра — значит однажды опубликовать спам или гадость от
 * своего же имени. Поэтому по умолчанию 'pending'.
 */
export const reviews = pgTable(
  'reviews',
  {
    id: id(),
    name: text('name').notNull(),
    // Почта не публикуется — нужна, чтобы ответить автору
    email: text('email').notNull(),
    role: text('role').notNull().default(''), // «Team lead», «Founder» — рядом с именем
    rating: integer('rating').notNull().default(5),
    body: text('body').notNull(),
    status: reviewStatus('status').notNull().default('pending'),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    meta: text('meta'),
    createdAt: createdAt(),
  },
  (t) => [index('reviews_status_idx').on(t.status, t.createdAt)],
)

/**
 * Настройки площадки: то, что меняют без выката новой сборки.
 *
 * Ключ-значение, а не колонки: список того, что хочется поменять текстом,
 * растёт быстрее, чем стоит гонять миграции.
 */
export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull().default(''),
  updatedAt: updatedAt(),
})
