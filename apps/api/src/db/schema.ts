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
    // Выбирал ли человек язык сам. Колонка выше NOT NULL, поэтому у всех есть
    // 'en' — и у тех, кто его не выбирал: заведённых через API компании.
    // Без этого признака письма им уходили по-английски мимо языка компании.
    localeSetByUser: boolean('locale_set_by_user').notNull().default(false),
    passwordHash: text('password_hash'),
    googleId: text('google_id'),
    avatarUrl: text('avatar_url'),
    avatarKey: text('avatar_key'), // S3-ключ загруженного аватара (раздаётся через /auth/avatar/:id)
    /**
     * Прошёл ли человек вводный тур по интерфейсу.
     *
     * Null — ещё не видел, показываем при первом заходе в проект. Дата — видел
     * и закрыл вопрос: прошёл до конца или вышел на середине, разницы нет.
     * Насильно возвращать того, кто вышел, нельзя — он ответил.
     *
     * Одна отметка на человека, а не на проект: интерфейс везде одинаковый, и
     * в каждом новом проекте повторять то же самое значит мешать работать.
     */
    tourSeenAt: timestamp('tour_seen_at', { withTimezone: true }),
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

/**
 * Вебхуки во внешнюю систему (SPEC-INTEGRATION §7).
 *
 * Без них их статистика узнаёт о наших изменениях только опросом: либо она
 * дёргает нас впустую каждую минуту, либо цифры отстают на эту минуту.
 */
export const companyWebhooks = pgTable(
  'company_webhooks',
  {
    id: id(),
    companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    // Им подписывается каждый запрос: принимающая сторона должна отличать нас
    // от любого, кто узнал адрес.
    secret: text('secret').notNull(),
    events: text('events').notNull().default('[]'), // пусто = все
    active: boolean('active').notNull().default(true),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    lastFailAt: timestamp('last_fail_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [index('company_webhooks_company_idx').on(t.companyId)],
)

/** Очередь доставки: их сервер может лежать, а наш ответ человеку — не ждать. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    webhookId: text('webhook_id').notNull().references(() => companyWebhooks.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    payload: text('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    // Растёт с каждой неудачей: долбить лежащий сервер каждую секунду — верный
    // способ добить его и попасть в чёрный список.
    nextTryAt: timestamp('next_try_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    lastStatus: integer('last_status'),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [index('webhook_deliveries_pending_idx').on(t.nextTryAt)],
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
  /**
   * Кто завёл компанию — «своя» она только для него.
   *
   * Без этого поля «свою» отличали по роли admin, а она достаётся и в чужой
   * компании: человека повысили — и он больше не может завести собственную,
   * хотя у него её нет. Роль говорит о правах внутри, а не о том, чьё это
   * пространство.
   *
   * set null при удалении человека: компания живёт дальше со своей командой,
   * а не исчезает вместе с тем, кто её когда-то создал.
   */
  createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  logoUrl: text('logo_url'),
  logoKey: text('logo_key'), // S3-ключ загруженного логотипа (раздаётся своей ручкой)
  // BYO-LLM: компания подключает своего провайдера; ключ — AES-256-GCM, наружу не отдаётся
  llmProvider: text('llm_provider'), // anthropic | openai | google | deepseek | groq
  llmModel: text('llm_model'),
  /**
   * Разрешено ли отправлять модели картинки.
   *
   * ВЫКЛЮЧЕНО по умолчанию, и это не перестраховка: не всякая модель умеет
   * смотреть изображения, а та, что не умеет, ответит ошибкой на весь запрос —
   * человек получит «не получилось» вместо ответа и не поймёт, почему.
   * Пусть включает осознанно, зная свою модель.
   *
   * Настройка у КОМПАНИИ, рядом с моделью: вижен — свойство модели, а она
   * одна на все проекты. Разрешение в проекте создавало бы иллюзию, что где-то
   * работает, а где-то нет.
   */
  llmVision: boolean('llm_vision').notNull().default(false),
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
  // --- автобэкап (SPEC §8.48) ---
  // Раз в сутки архив компании уезжает в её же хранилище. Кнопку «сделать
  // бэкап» никто не нажимает ежедневно, а вспоминают о ней в день потери.
  autoBackup: boolean('auto_backup').notNull().default(false),
  lastBackupAt: timestamp('last_backup_at', { withTimezone: true }),
  lastBackupError: text('last_backup_error'),
  backupErrorNotifiedAt: timestamp('backup_error_notified_at', { withTimezone: true }),

  // --- своя почта компании (SPEC §8.41) ---
  // Письма уходят с домена компании, а не с нашего: письмо «от Chatick» про
  // внутренние задачи выглядит как фишинг, и SPF/DKIM нашего домена к их
  // адресу отношения не имеют — почтовики понижают такие письма.
  mailProvider: text('mail_provider'), // smtp | sendgrid; пусто — общая почта
  mailFromEmail: text('mail_from_email'),
  mailFromName: text('mail_from_name'),
  mailReplyTo: text('mail_reply_to'),
  mailHost: text('mail_host'),
  mailPort: integer('mail_port'),
  mailUser: text('mail_user'),
  // Секреты — AES-256-GCM, как ключ LLM. Наружу не отдаются никогда: ими
  // шлют почту от имени компании.
  mailPasswordEnc: text('mail_password_enc'),
  mailApiKeyEnc: text('mail_api_key_enc'),
  // Когда настройки последний раз подтверждались живой отправкой.
  mailVerifiedAt: timestamp('mail_verified_at'),

  // --- связь с внешней системой (SPEC-INTEGRATION) ---
  // Название и шаблон ссылки — настройки, а не код: так интеграция остаётся
  // универсальной, без следов конкретного заказчика.
  externalSystemName: text('external_system_name'),
  externalProjectUrl: text('external_project_url'), // https://…/projects/{externalId}
  // --- учёт времени (SPEC §8.36) ---
  // Живёт на компании, а не на проекте: часовой пояс, рабочие часы и правила
  // забытого таймера — свойства организации, а не отдельной работы. Задавать
  // их заново в каждом проекте значило заводить десять способов разойтись.
  // Поле projects.time_config остаётся на месте под возможное переопределение
  // отдельным проектом — из интерфейса его убрали, но не из данных.
  timeConfig: text('time_config').notNull().default('{}'),
  /**
   * Уведомления по умолчанию для всех проектов компании (SPEC §8.9).
   *
   * JSON: { events: { chat_mention: bool, ... }, dueLeadHours: number,
   *         dueEnabled: bool }.
   *
   * Наследование, а не копия при создании — как у time_config: правило
   * «о сроках предупреждаем за сутки» заводят один раз на компанию, и когда
   * его меняют, ждут, что оно поменяется везде, а не только в проектах,
   * заведённых после. Проект может переопределить своим notify_config;
   * «{}» значит «не задано», а не «всё выключено».
   */
  notifyConfig: text('notify_config').notNull().default('{}'),
  /**
   * Главный проект компании — умолчание для трея (SPEC §8.33).
   *
   * Панель открывалась с «Выберите проект», и таймер нельзя было запустить,
   * пока не выберешь: на новой машине и после чистки хранилища — каждый раз
   * заново. Личный выбор живёт в localStorage одного устройства, а это —
   * умолчание для всех, кто ещё не выбрал.
   *
   * Личный выбор ОСТАЁТСЯ главнее: жёсткая настройка перетирала бы его при
   * каждой перерисовке, и это раздражало бы сильнее, чем отсутствие
   * умолчания.
   *
   * set null при удалении проекта: настройка не должна указывать в пустоту.
   */
  mainProjectId: text('main_project_id'),
  // Проекты приходят только через API — кнопка создания в интерфейсе исчезает.
  projectsViaApiOnly: boolean('projects_via_api_only').notNull().default(false),
  // То же для людей: состав команды виден, но правится только снаружи. Иначе
  // уволенный во внешней системе остаётся у нас и продолжает читать переписку.
  membersViaApiOnly: boolean('members_via_api_only').notNull().default(false),
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
    /**
     * Должность и зона ответственности — на уровне компании.
     *
     * Проект наследует их, пока не задал своё: должность человека не меняется
     * от проекта к проекту, а заводить её в каждом заново — десять мест,
     * где она разойдётся. Наследование, а не копия при добавлении: меняя
     * должность здесь, ждут, что она изменится везде.
     *
     * Читает это в первую очередь ассистент: «спроси у Даниэля» осмысленно
     * только если известно, что Даниэль — бэкендер.
     */
    jobTitle: text('job_title').notNull().default(''),
    responsibility: text('responsibility').notNull().default(''),
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
    // Уведомления проекта; «{}» = берём у компании (см. companies.notify_config)
    notifyConfig: text('notify_config').notNull().default('{}'),
    logoUrl: text('logo_url'),
    logoKey: text('logo_key'),
    // Идентификатор и имя проекта в системе заказчика. Имя показывается рядом
    // с нашим: он зовёт проект по клиенту, мы — по сути работы.
    externalId: text('external_id'),
    externalName: text('external_name'),
    // NULL = наследовать от компании. Отдельное значение от 'en': иначе не
    // отличить «выбрали английский» от «не выбирали».
    locale: text('locale'),
    /**
     * Проект закончен и убран с глаз. НЕ удаление.
     *
     * Отдельная колонка, а не deletedAt: смысл другой и цена ошибки разная.
     * Архив обратим и ничего не трогает — задачи, переписка, файлы и часы
     * остаются. Удаление необратимо. Свести их в одну колонку значит однажды
     * стереть то, что просили просто убрать из списка.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
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
    // Срок сдачи проекта. Дата, а не отметка времени: «до 14-го» — это до конца
    // дня, и час здесь только мешал бы. NULL — срока нет, и это обычное дело:
    // у внутренних проектов его чаще нет, чем есть.
    deadline: timestamp('deadline', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('projects_company_idx').on(t.companyId)],
)

// Настройка хранилища проекта (SPEC §8.10): platform (наш, лимит) | custom (свой S3/R2, без лимита).
// Ключи шифруются (AES-256-GCM), в ответах API — только метаданные.
export const storageProvider = pgEnum('storage_provider', ['platform', 'custom'])

// Своё хранилище компании (SPEC §8.47). Проекты наследуют его по умолчанию:
// вводить одни и те же ключи R2 для каждого проекта, а потом менять их во всех
// разом — работа, которой быть не должно.
export const companyStorage = pgTable('company_storage', {
  companyId: text('company_id').primaryKey().references(() => companies.id, { onDelete: 'cascade' }),
  provider: storageProvider('provider').notNull().default('platform'),
  endpoint: text('endpoint'),
  region: text('region').notNull().default('auto'),
  bucket: text('bucket'),
  accessKeyEncrypted: text('access_key_encrypted'),
  secretKeyEncrypted: text('secret_key_encrypted'),
  publicUrl: text('public_url'),
  updatedAt: updatedAt(),
})

// Хранилище ДЛЯ БЭКАПОВ — отдельное от файлового (SPEC §8.48).
//
// Со своими ключами и endpoint, а не только именем бакета: копию имеет смысл
// держать в другом аккаунте, а лучше у другого провайдера. Лежащая в том же
// аккаунте, она недоступна ровно тогда, когда нужна — при его блокировке или
// компрометации.
//
// Не задано — бэкап пишется в файловое хранилище компании.
export const companyBackupStorage = pgTable('company_backup_storage', {
  companyId: text('company_id').primaryKey().references(() => companies.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint'),
  region: text('region').notNull().default('auto'),
  bucket: text('bucket'),
  accessKeyEncrypted: text('access_key_encrypted'),
  secretKeyEncrypted: text('secret_key_encrypted'),
  updatedAt: updatedAt(),
})

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
    /**
     * Докуда человек дочитал каждый канал.
     *
     * Два поля, а не одно: чат и ассистент — разные разговоры, и «есть
     * новое» про них отвечается отдельно. Открыв ассистента, человек не
     * прочитал групповой чат.
     *
     * В базе, а не в браузере: иначе на втором устройстве всё
     * непрочитанное показалось бы заново.
     *
     * Null — не открывал ни разу. Считать это «всё непрочитано» честнее,
     * чем «всё прочитано»: в новом проекте бейдж позовёт заглянуть.
     */
    lastSeenGroupAt: timestamp('last_seen_group_at', { withTimezone: true }),
    lastSeenAiAt: timestamp('last_seen_ai_at', { withTimezone: true }),
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

/**
 * Порядок значений — это порядок работы, и он читается сверху вниз.
 *
 * verified между review и done: раньше review означал сразу два состояния —
 * «сдал, жду проверки» и «проверено, жду закрытия». По доске не было видно,
 * чей ход, и команда на это жаловалась.
 */
export const taskStatus = pgEnum('task_status', ['todo', 'in_progress', 'review', 'verified', 'done'])
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
    /**
     * Свои номера задачи — то, чем её зовут ВНЕ Chatick: экраны в макете,
     * пункты договора, позиции сметы. Строка, а не число и не связь: у каждой
     * команды свой счёт, и «12 - 14» у одних значит диапазон, у других —
     * составной номер. Разбираем только по запятой, остальное сохраняем как
     * написали.
     */
    refs: text('refs').notNull().default(''),
    // ручной порядок внутри статус-группы (drag&drop); меньше = выше
    sortOrder: doublePrecision('sort_order').notNull().default(0),
    dueDate: timestamp('due_date', { withTimezone: true }),
    /**
     * Когда предупредили о приближении срока — чтобы не предупреждать дважды.
     *
     * Тик планировщика идёт каждые 5 минут, и без метки человек получал бы
     * напоминание двенадцать раз в час. Сбрасывается в null при смене
     * due_date: перенесли срок — значит, про новый ещё не предупреждали.
     */
    dueNotifiedAt: timestamp('due_notified_at', { withTimezone: true }),
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

/**
 * Зависимости между задачами: «эта ждёт ту».
 *
 * Одна строка = одна связь: blockedTaskId ЖДЁТ blockerTaskId. Обратное
 * направление («кого держит эта») — тот же список, прочитанный с другой
 * стороны, поэтому второй таблицы нет и рассинхронизироваться нечему.
 *
 * Связь переживает закрытие блокирующей задачи: это факт о работе, а не
 * временный флаг. Замочек гаснет сам, когда все блокеры завершены, а история
 * «что чего ждало» остаётся — иначе через месяц не восстановить, почему
 * задача простояла две недели.
 *
 * Кольца (A ждёт B ждёт A) запрещены на записи: обе задачи в кольце
 * невозможно закрыть никогда.
 */
export const taskBlockers = pgTable(
  'task_blockers',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    /** Кто ждёт. */
    blockedTaskId: text('blocked_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    /** Кого ждёт. */
    blockerTaskId: text('blocker_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    // Одна и та же связь дважды — это не две связи.
    uniqueIndex('task_blockers_pair_idx').on(t.blockedTaskId, t.blockerTaskId),
    index('task_blockers_blocked_idx').on(t.blockedTaskId),
    index('task_blockers_blocker_idx').on(t.blockerTaskId),
    index('task_blockers_project_idx').on(t.projectId),
  ],
)

/**
 * Связи между задачами: происхождение и сходство.
 *
 * Отдельной таблицей от task_blockers, а не полем kind в ней: смешав их,
 * пришлось бы всюду фильтровать «а это блокер или нет», и однажды забудут —
 * тогда «похожая задача» начнёт гасить замочком чужую работу. Здесь про то,
 * откуда задача взялась, там — про порядок работ. Разные вопросы.
 */
export const taskLinks = pgTable(
  'task_links',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    /** Откуда смотрим: у derived — порождённая задача. */
    fromTaskId: text('from_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    /** Куда: у derived — исходная, из которой выросли. */
    toTaskId: text('to_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    /**
     * derived — «выросла из», направленная и читается по-разному с двух сторон.
     * related — «связано», симметричная: обе стороны видят одно и то же.
     */
    kind: text('kind').notNull().default('related'),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    // Одна и та же связь дважды — это не две связи.
    uniqueIndex('task_links_pair_idx').on(t.fromTaskId, t.toTaskId),
    index('task_links_from_idx').on(t.fromTaskId),
    index('task_links_to_idx').on(t.toTaskId),
    index('task_links_project_idx').on(t.projectId),
  ],
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
    /**
     * Проект — метка ПРОИСХОЖДЕНИЯ, а не граница доступа: «это выяснилось
     * там». Необязательна: правило компании ни к какому проекту не привязано.
     *
     * SET NULL, а не CASCADE: закрыли проект — знание, добытое в нём, обязано
     * пережить его. Прежний каскад стирал решения вместе с проектом, ровно
     * наоборот тому, ради чего база знаний заводится.
     */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    /** Владелец записи. Видят все, кто в компании. */
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
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
 * Журнал работы: что человек делал в проекте и где остановился.
 *
 * Чем отличается от заметки (notes) — природой записи. Заметка это ЗНАНИЕ:
 * «Cardcom не берёт иностранные карты, лечится так-то», её ищут через год.
 * Запись журнала это СОБЫТИЕ: «доделал вебхук, встал на ретраях, завтра
 * оттуда», она ценна неделю и только рядом с соседними.
 *
 * Чем отличается от истории проекта (activity_log) — рукой. Там пишет машина:
 * «изменил статус», «удалил файл». Здесь пишет человек, и пишет то, чего
 * машина знать не может: что оказалось сложнее, чем думал.
 *
 * Чем отличается от описания к записи времени — тем, что его не пишут. У
 * time_entries.description на живой базе 7 заполненных из 96, средняя длина 2
 * символа. Поле под рассказ о работе там есть, и оно мёртвое: приходя
 * отметить часы, о работе не рассказывают.
 *
 * Правило неизменности: опубликованное не правится. Журнал, который
 * переписывают задним числом, перестаёт быть журналом — а именно за
 * «что я делал в марте» в него и придут.
 */
export const workLog = pgTable(
  'work_log',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull().default(''), // HTML, как в заметках и документах
    /** draft — виден ТОЛЬКО автору, нигде больше; published — по правам проекта. */
    status: text('status').notNull().default('draft'),
    /**
     * Момент публикации, отдельно от createdAt.
     *
     * Черновик пишут в понедельник, публикуют в пятницу. Лента стоит по этой
     * дате: она отвечает на вопрос «когда это стало историей», а не «когда я
     * начал набирать текст».
     */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /**
     * Задача — необязательна: «разбирался с окружением полдня» не про задачу.
     * SET NULL: задачу удалили, рассказ о сделанной работе остаётся.
     */
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('work_log_project_idx').on(t.projectId, t.createdAt),
    index('work_log_author_idx').on(t.projectId, t.authorId, t.createdAt),
    // Черновик у человека в проекте один — правило держит база, а не код:
    // две вкладки заведут второй быстрее, чем проверка увидит первый.
    // Частичный индекс объявлен в миграции 0094: drizzle не умеет WHERE.
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
    /**
     * Тип предложения (SPEC §5.5.3).
     *
     * Пусто — исторический случай: вариант текста сообщения, который «Выбрать»
     * отправляет в чат. Так работал sandbox с самого начала.
     *
     * 'tasks' — задачи, которые предлагается создать вместо отправки реплики в
     * чат: «Артём, проверь функцию» — это работа, а не разговор, и в чате она
     * теряется. Поля задач лежат в payload, исполняет их сервер по кнопке.
     *
     * Почему не «модель сама создаст, когда человек согласится»: тогда
     * созданное определяется её пониманием диалога, а не тем, что человек
     * видел в карточке. Кнопка исполняет ровно показанное.
     */
    kind: text('kind'),
    payload: text('payload'), // JSON под kind
    // Исполнено — чтобы карточка не сработала дважды: у held-сообщения
    // sandbox остаётся открытым, и «Создать» можно нажать повторно.
    appliedAt: timestamp('applied_at', { withTimezone: true }),
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

/**
 * Кто видит секреты ресурса.
 *
 * Ссылка и описание доступны всем участникам проекта — это адрес макета, а не
 * тайна. Ограничение касается ТОЛЬКО секретов под ресурсом: пароля, ключа,
 * строки подключения.
 *
 * Автора в таблице нет и быть не должно: он видит свои секреты всегда, по
 * created_by_id. Запись автора здесь означала бы, что её можно удалить и
 * оставить ресурс без единого владельца — с секретом, который больше никто не
 * откроет.
 */
/**
 * Файлы под ресурсом: кейстор, сертификат, ключ, .env.
 *
 * ОТДЕЛЬНАЯ таблица от files, а не флаг в ней. Флаг однажды забудут в одной
 * из выборок — в менеджере, в поиске, в выдаче задачи — и ключ подписи
 * окажется на виду у всего проекта. Разные сущности живут в разных таблицах
 * именно затем, чтобы такую ошибку нельзя было совершить по невнимательности.
 *
 * В хранилище лежит ШИФРОТЕКСТ (encryptBytes), не исходник: тот, кто получит
 * доступ к бакету, файла не прочитает. Ключ шифрования — в .env, в базу не
 * попадает ни в каком виде.
 *
 * Права наследуются от ресурса через resource_viewers, как у текстовых
 * секретов: адрес и описание видят все участники проекта, файл — нет.
 */
export const resourceFiles = pgTable(
  'resource_files',
  {
    id: id(),
    resourceId: text('resource_id').notNull().references(() => credentials.id, { onDelete: 'cascade' }),
    /** Исходное имя: в хранилище ключ обезличен, а человеку нужно «main.jks». */
    name: text('name').notNull(),
    /** Ключ объекта в S3/R2. Под ним лежит шифротекст. */
    key: text('key').notNull(),
    mime: text('mime').notNull().default('application/octet-stream'),
    /** Размер ИСХОДНОГО файла, а не шифротекста: его показывают человеку. */
    size: text('size').notNull().default('0'),
    uploadedById: text('uploaded_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('resource_files_idx').on(t.resourceId)],
)

export const resourceViewers = pgTable(
  'resource_viewers',
  {
    id: id(),
    resourceId: text('resource_id').notNull().references(() => credentials.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('resource_viewers_idx').on(t.resourceId),
    // Один человек — одна запись: повторное добавление не должно плодить
    // дубликаты, иначе снятие доступа снимает только одну из них.
    uniqueIndex('resource_viewers_unique').on(t.resourceId, t.userId),
  ],
)

/**
 * Связь задачи с ресурсами — необязательная.
 *
 * Задаче нужны доступы: «вот стенд, вот ключ». Держать их копией в описании
 * значит рассыпать секреты по тексту, который читают все; ссылка на ресурс
 * оставляет право решать за самим ресурсом.
 */
/**
 * Что включено в проекте.
 *
 * Версии нужны не каждому: в проекте без релизов лишняя вкладка — шум.
 * Отдельная таблица, а не колонка у проекта: функций со временем станет
 * больше, и колонка на каждую превратила бы projects в свалку флагов.
 */
export const projectFeatures = pgTable(
  'project_features',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Ключ функции: пока только 'releases'. Строка, а не енам — добавлять без миграции. */
    feature: text('feature').notNull(),
    enabledById: text('enabled_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('project_features_unique').on(t.projectId, t.feature)],
)

/**
 * Версии проекта: что и куда выкачено.
 *
 * Отвечает на вопрос, который сейчас задают голосом: «какая версия в проде».
 *
 * Статус НЕ синхронизируется со статусом задачи. У задачи свои четыре
 * состояния, у версии — путь до магазина, и совпадают они только случайно:
 * «review» у задачи это «команда смотрит», а не «Apple смотрит», и «done»
 * наступает раньше, чем версия доедет до людей.
 */
export const releases = pgTable(
  'releases',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** «1.4.0» — как называет её команда, а не как пронумеровал сборщик. */
    version: text('version').notNull(),
    /**
     * Что именно собрано: «Клиент», «Провайдер», «Админка».
     *
     * У одного проекта бывает несколько приложений, и тип сборки их не
     * различает: клиент под iOS и провайдер под iOS — обе «ios». Без имени
     * сводка «что сейчас в проде» схлопывала их в одну строку, и второе
     * приложение пропадало из виду совсем.
     *
     * В базе поле необязательное, а в форме обязательное: у версий, заведённых
     * до его появления, имени нет, и NOT NULL сломал бы их. Пусто читается как
     * «приложение одно», и для проектов с единственным приложением это правда.
     */
    appName: text('app_name'),
    /** Ключ из BUILD_TYPES: ios | android | web | backend | desktop | other. */
    buildType: text('build_type').notNull(),
    /** Ключ стадии из набора этого типа сборки. */
    status: text('status').notNull(),
    /**
     * АВТОР версии, не исполнитель.
     *
     * Кому поручено — живёт в связанной задаче и только там. Второе поле
     * «ответственный» разошлось бы с первым при первом же переназначении.
     */
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * Чем собрано: development | preview | production — профиль сборки.
     *
     * НЕ то же, что стадия, и потому отдельным полем. Стадия отвечает «куда
     * доехало» (TestFlight, App Store), профиль — «чем собрали» (eas build
     * --profile). Одна и та же production-сборка проходит и TestFlight, и
     * магазин, а preview-сборка может застрять на первой стадии навсегда.
     * Свести их в одно поле значит потерять один из двух ответов.
     *
     * Строка, а не енам: у команд бывают свои профили, и новый не должен
     * требовать миграции. Пусто — не указан, для веба он часто и не нужен.
     */
    buildProfile: text('build_profile'),
    /** Ссылка на сборку: Expo, GitHub, магазин — что угодно. Необязательна. */
    referenceUrl: text('reference_url'),
    /**
     * Страница сборки в системе сборки (EAS build details).
     *
     * Отдельно от referenceUrl, потому что отвечают на разное: referenceUrl —
     * «скачать артефакт», а это — «посмотреть логи, статус, кто запустил».
     * Когда сборка падает, нужна именно вторая, а артефакта нет вовсе.
     */
    buildPageUrl: text('build_page_url'),
    /** Что нового — для команды, не для магазина. */
    notes: text('notes'),
    /** Когда доехало до людей: проставляется при переходе на конечную стадию. */
    releasedAt: timestamp('released_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('releases_project_idx').on(t.projectId),
    // Сводка «что сейчас в проде» ходит именно так: проект + тип сборки.
    index('releases_project_type_idx').on(t.projectId, t.buildType),
  ],
)

/**
 * История стадий версии: кто, когда и — обязательно — почему.
 *
 * Отдельной таблицей, а не полем у версии: поле хранит только последнее, а
 * ценна именно лента. «Почему 1.4 неделю висит в ревью Apple» — вопрос из
 * того же ряда, что и «какая версия в проде», и ответ на него теряется, если
 * каждый следующий переход затирает предыдущий.
 *
 * Комментарий обязателен. Пустой переход не объясняет ничего, а спросить
 * задним числом уже не у кого: человек не вспомнит, почему две недели назад
 * откатил сборку.
 */
/**
 * Интеграция проекта с Expo (EAS).
 *
 * Одна на проект: у команды один аккаунт Expo, а разные приложения внутри
 * различаются именем сборки, которое приходит в самом вебхуке.
 *
 * Секрет хранится, чтобы проверять подпись входящих: EAS подписывает тело
 * HMAC-SHA1 и шлёт в заголовке expo-signature. Без проверки ручка принимала бы
 * что угодно от кого угодно — а она двигает стадии релизов.
 */
export const projectIntegrations = pgTable(
  'project_integrations',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Пока только 'expo'. Строка, а не енам: следующая не потребует миграции. */
    kind: text('kind').notNull(),
    /**
     * Секрет вебхука. Его же человек указывает в eas webhook:create.
     *
     * Лежит открытым намеренно: это не пароль от чего-либо, а общий секрет для
     * проверки подписи, и показать его нужно тому, кто настраивает интеграцию.
     * Права на чтение — те же, что на управление релизами.
     */
    secret: text('secret').notNull(),
    /** Когда последний раз приходил вебхук: видно, живая связь или нет. */
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('project_integrations_unique').on(t.projectId, t.kind)],
)

export const releaseEvents = pgTable(
  'release_events',
  {
    id: id(),
    releaseId: text('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    /** Стадия, В которую перешли. Пусто — создание версии. */
    status: text('status').notNull(),
    /** Откуда перешли: для ленты «staging → prod» без обращения к соседям. */
    fromStatus: text('from_status'),
    /** Свободный текст: что произошло. Обязателен на уровне ручки. */
    comment: text('comment').notNull(),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('release_events_release_idx').on(t.releaseId, t.createdAt)],
)

/**
 * Связь версии с задачами — необязательная с обеих сторон.
 *
 * Версия живёт без задачи: собрал и залил за две минуты, заводить под это
 * задачу — бюрократия. Задача живёт без версии. А «подними в Google Play» на
 * другого человека — уже настоящая задача, и таких у одной версии бывает
 * несколько.
 */
export const taskReleases = pgTable(
  'task_releases',
  {
    id: id(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    releaseId: text('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('task_releases_task_idx').on(t.taskId),
    index('task_releases_release_idx').on(t.releaseId),
    uniqueIndex('task_releases_unique').on(t.taskId, t.releaseId),
  ],
)

export const taskResources = pgTable(
  'task_resources',
  {
    id: id(),
    taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    resourceId: text('resource_id').notNull().references(() => credentials.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('task_resources_task_idx').on(t.taskId),
    index('task_resources_resource_idx').on(t.resourceId),
    uniqueIndex('task_resources_unique').on(t.taskId, t.resourceId),
  ],
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
  // Ответ под пунктом чек-листа. Отдельно от task_comment: инбокс группирует
  // по событию, и «на мой вопрос ответили» нельзя было бы отделить от «кто-то
  // что-то написал». Заголовок «прокомментировал» тоже был бы неправдой —
  // человек открыл бы комментарии и ничего не нашёл.
  'checklist_answer',
  'note_mention', // тебя упомянули в заметке проекта
  'note_reminder', // наступила дата напоминания в заметке
  'timer_running', // таймер идёт слишком долго — не забыли ли выключить
  'release_status', // версия сдвинулась по стадиям — автору и тем, кого это касается
  'task_due', // срок задачи на подходе — предупреждаем заранее
  // Объявление компании: «завтра отдыхаем», «изменили политику». Первое
  // событие без повода внутри проекта — оттого и project_id стал
  // необязательным.
  'announcement',
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
    /**
     * Проект — у всего, кроме объявлений компании: «вам назначили задачу» без
     * задачи бессмысленно, а «завтра отдыхаем» к проекту не привязано вовсе.
     */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /**
     * Компания. Раньше выводилась из проекта; у объявления проекта нет, а
     * знать, чьё оно, необходимо — инбокс группирует по компаниям.
     */
    companyId: text('company_id').references(() => companies.id, { onDelete: 'cascade' }),
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

/**
 * Векторы текстов — поиск по смыслу.
 *
 * ОБЩАЯ таблица, а не «векторы заметок»: ассистент ищет не заметку и не
 * задачу, а ОТВЕТ, и лежать он может в любом из них. Отсюда entity_type +
 * entity_id, а подключение задач — строка в коде, а не вторая таблица.
 *
 * projectId и companyId дублируются сюда намеренно: поиск обязан отсеивать
 * чужое по правам прямо в запросе, а не после. Джойн на четыре таблицы ради
 * одного фильтра стоил бы дороже дублирования.
 */
export const embeddings = pgTable(
  'embeddings',
  {
    id: id(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    companyId: text('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    /** vector(512) — drizzle его не типизирует, работаем через sql. */
    embedding: text('embedding'),
    /** Отпечаток текста: правка, не менявшая его, не тратит денег на пересчёт. */
    contentHash: text('content_hash').notNull(),
    /** Векторы разных моделей несравнимы — поле говорит, какие устарели. */
    model: text('model').notNull().default('text-embedding-3-small'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('embeddings_entity_idx').on(t.entityType, t.entityId),
    index('embeddings_company_idx').on(t.companyId),
  ],
)

/**
 * Очередь пересчёта векторов.
 *
 * Вектор считается ВНЕ запроса пользователя: обращение к модели занимает
 * сотни миллисекунд, а сохранение заметки должно быть мгновенным. И если
 * модель недоступна, заметка обязана сохраниться всё равно.
 *
 * Без очереди такая запись терялась бы молча: она есть, а поиском не
 * находится, и узнать об этом можно только не найдя её однажды.
 */
export const embeddingQueue = pgTable(
  'embedding_queue',
  {
    id: id(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('embedding_queue_entity_idx').on(t.entityType, t.entityId),
    index('embedding_queue_pick_idx').on(t.attempts, t.createdAt),
  ],
)

/**
 * Отметки об отправленных предупреждениях о тратах.
 *
 * Планировщик тикает каждые пять минут. Без отметки письмо «траты за месяц
 * перевалили за порог» уходило бы 288 раз в сутки, и человек отключил бы его
 * на второй день — вместе с настоящими предупреждениями.
 *
 * Отдельная таблица, а не колонка у компании: порог считается по ВСЕМ тратам
 * сервера. Уникальность по (period, kind) живёт в базе, а не в коде: два
 * процесса тикают независимо, и проверка «посмотрели, потом вставили»
 * пропустила бы второе письмо между этими шагами.
 */
export const spendAlerts = pgTable(
  'spend_alerts',
  {
    id: id(),
    /** «2026-08» — месяц, за который считались траты. */
    period: text('period').notNull(),
    kind: text('kind').notNull().default('monthly_threshold'),
    amountUsd: text('amount_usd').notNull(),
    sentTo: text('sent_to').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('spend_alerts_period_idx').on(t.period, t.kind)],
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

/**
 * Короткие ссылки: chatick.com/t-AbC12 вместо адреса на 90 символов.
 *
 * Это НЕ публикация. Ссылка только ведёт на длинный адрес, а дальше работают
 * обычные права: у кого нет доступа к проекту, тот попадёт на вход. Публичный
 * доступ — отдельный механизм (shares), с отзывом и сроком; смешивать их
 * нельзя, иначе «поделиться с коллегой» однажды означало бы «открыть всем».
 *
 * Код не выводится из id сущности: по «t-AbC12» нельзя ни угадать соседнюю
 * задачу, ни восстановить внутренний идентификатор.
 *
 * Тип хранится рядом с кодом, а не кодируется в нём: префикс в адресе — для
 * человека («t-» читается как задача»), а разбирает ссылку всё равно эта
 * таблица. Так добавление нового вида сущности не ломает уже выданные ссылки.
 */
export const shortLinks = pgTable(
  'short_links',
  {
    id: id(),
    // Код без префикса: «AbC12». Префикс живёт в адресе и в entityType.
    code: text('code').notNull().unique(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    // Проект — для сборки длинного адреса и для зачистки: удалили проект,
    // ссылки ушли вместе с ним, а не остались вести в никуда.
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    // Одна ссылка на сущность: вторая означала бы, что у одной задачи два
    // «коротких адреса», и в переписке они выглядели бы как разные задачи.
    uniqueIndex('short_links_entity_idx').on(t.entityType, t.entityId),
    index('short_links_project_idx').on(t.projectId),
  ],
)

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
// «Сделано» — отдельно от «ответили»: на просьбу можно ответить и не сделать,
// а внедрённое улучшение не всегда требует ответа. Без этого различия список
// улучшений неотличим от списка вопросов, на которые уже написали.
export const feedbackStatus = pgEnum('feedback_status', ['new', 'read', 'answered', 'done'])

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
    /**
     * Кто отправил: человек через форму или ассистент через мост.
     *
     * Отдельным полем, а не догадкой по тексту: репорты ассистента читают
     * иначе. Он видит, чего не хватило в API, но не видит, насколько это
     * больно человеку — и пишет чаще, чем человек стал бы.
     */
    source: text('source').notNull().default('human'),
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

// Журнал входов под чужим аккаунтом (суффикс «:dev» при запросе кода).
//
// Помогать людям с проблемами входа нужно, но такой вход открывает чужую
// переписку и в обычных логах неотличим от настоящего. Здесь остаётся след:
// кого открывали, кто входил, когда и с какого адреса.
export const supportLogins = pgTable(
  'support_logins',
  {
    id: text('id').primaryKey().$defaultFn(() => nanoid()),
    // Без каскада: пользователя могут удалить, а запись о доступе к его
    // данным должна пережить удаление.
    targetUserId: text('target_user_id'),
    targetEmail: text('target_email').notNull(),
    sentTo: text('sent_to').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    usedAt: timestamp('used_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('support_logins_target_idx').on(t.targetUserId, t.createdAt)],
)

// --- Подключения к внешним БД (шаг 1: только чтение) -------------------------
//
// Отдельные таблицы, ничего существующего не трогают. Фича новая и может не
// прижиться: снести её — это DROP трёх таблиц и удаление своих файлов, без
// правки чужих данных. Плюс выключатель в окружении (DB_CONNECTIONS_ENABLED):
// выключено — ручки отвечают 404 и подключения не устанавливаются вовсе.

export const dbConnectionKind = pgEnum('db_connection_kind', ['postgres', 'mysql'])

/**
 * Подключение к чужой БД. Живёт у проекта: база относится к конкретной работе,
 * как и ресурсы, и права наследует от проекта.
 *
 * Строка подключения шифруется тем же способом, что и секреты ресурсов: в
 * дампе базы её нет. Наружу не отдаётся НИКОГДА — ни в интерфейс, ни через
 * мост; показываем только хост и имя базы, чтобы человек понимал, куда
 * подключён, и не мог случайно скопировать пароль в переписку.
 */
export const dbConnections = pgTable(
  'db_connections',
  {
    id: id(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: dbConnectionKind('kind').notNull(),
    /** Разобранные части — для показа человеку. Пароля здесь нет. */
    host: text('host').notNull().default(''),
    database: text('database').notNull().default(''),
    dsnEncrypted: text('dsn_encrypted').notNull(),
    /**
     * Запись по этому подключению разрешена вообще.
     *
     * По умолчанию ВЫКЛЮЧЕНО. Шаг 1 записи не умеет, но флаг заводим сразу:
     * добавить его потом значит менять таблицу с боевыми подключениями.
     */
    writeEnabled: boolean('write_enabled').notNull().default(false),
    /** Последняя удачная проверка связи — чтобы «не работает» было видно сразу. */
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('db_connections_project_idx').on(t.projectId)],
)

/**
 * Какие таблицы вообще видны и что с ними можно.
 *
 * Белый список, а не чёрный: таблица, о которой забыли, должна быть НЕдоступна.
 * Схему стягиваем автоматически, но каждая таблица приходит выключенной —
 * решение «эту можно» принимает человек, а не автоопределение.
 */
export const dbTablePolicies = pgTable(
  'db_table_policies',
  {
    id: id(),
    connectionId: text('connection_id').notNull().references(() => dbConnections.id, { onDelete: 'cascade' }),
    schemaName: text('schema_name').notNull().default('public'),
    tableName: text('table_name').notNull(),
    /** Читать эту таблицу. Выключено по умолчанию. */
    canRead: boolean('can_read').notNull().default(false),
    /** Писать в эту таблицу. Отдельно от canRead и тоже выключено. */
    canWrite: boolean('can_write').notNull().default(false),
    /**
     * Колонки, которые НЕ отдаём наружу: пароли, токены, персональные данные.
     * JSON-массив имён. Проверяется и на чтении — иначе «покажи всё из users»
     * выгрузит хеши паролей в переписку с моделью.
     */
    hiddenColumns: text('hidden_columns').notNull().default('[]'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('db_table_policies_uniq_idx').on(t.connectionId, t.schemaName, t.tableName)],
)

/**
 * Журнал обращений к чужой БД: кто, что и с каким результатом.
 *
 * Сам запрос пишем, СТРОКИ — нет: в них персональные данные заказчика, и
 * копить их у себя мы не имеем права. Для записи (шаг 2) здесь же будет
 * снимок затронутых строк — но это отдельное поле и отдельное решение.
 */
export const dbQueryLog = pgTable(
  'db_query_log',
  {
    id: id(),
    connectionId: text('connection_id').notNull().references(() => dbConnections.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Пришло из моста (ассистент) или из интерфейса — разбирать инциденты. */
    viaBridge: boolean('via_bridge').notNull().default(false),
    kind: text('kind').notNull(), // read | write
    sqlText: text('sql_text').notNull(),
    rowCount: integer('row_count'),
    ms: integer('ms'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('db_query_log_conn_idx').on(t.connectionId, t.createdAt)],
)
