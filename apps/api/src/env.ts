import { config } from 'dotenv'
config()

import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3200),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().min(1),

  JWT_SECRET: z.string().min(32),
  // 32 байта hex — шифрование кредишенов (AES-256-GCM)
  ENCRYPTION_KEY: z.string().length(64),

  CORS_ORIGIN: z.string().default('*'),

  // Разбор чужих проблем со входом: адрес e-mail с суффиксом «:dev» шлёт код
  // не владельцу ящика, а сюда. Люди действительно просят «зайди и посмотри»,
  // а без этого помочь нечем.
  //
  // Пусто — механизма нет вовсе. Не значение по умолчанию: адрес, случайно
  // въехавший в репозиторий, стал бы ключом от всех аккаунтов.
  SUPPORT_LOGIN_EMAIL: z.string().optional(),

  /**
   * Демо-аккаунт для проверяющих в магазинах приложений.
   *
   * Microsoft и Apple присылают рецензента, который видит форму входа и не
   * может пройти дальше: код уходит на почту, доступа к ней у него нет. Без
   * рабочего входа подачу отклоняют — это самая частая причина отказа.
   *
   * Поэтому для ОДНОГО адреса код не отправляется и не меняется. Пять условий,
   * без которых это был бы мастер-ключ:
   *
   * 1. Работает ровно для DEMO_LOGIN_EMAIL. Любой другой адрес — обычный вход.
   * 2. Пусто в любой из двух переменных — механизма нет вовсе. Репозиторий
   *    открыт, и «забыли выключить» не должно превращаться в чужой вход.
   * 3. Код задаётся только здесь и в репозиторий не попадает.
   * 4. Аккаунт заводится руками и держится в отдельной демо-компании: даже
   *    открытый, он не ведёт к чужим данным.
   * 5. Каждый такой вход пишется в журнал — как и служебный.
   */
  DEMO_LOGIN_EMAIL: z.string().optional(),
  DEMO_LOGIN_CODE: z.string().optional(),
  /**
   * Подключения к внешним БД — фича новая и может не прижиться.
   *
   * Выключено — ручки отвечают 404 и подключение к чужой базе не
   * устанавливается вовсе. Это не «скрыто в интерфейсе», а мёртвый код на
   * сервере: погасить фичу можно без выкатки.
   */
  DB_CONNECTIONS_ENABLED: z.string().optional(),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().min(1),

  // LLM (диспетчер чата) — обязательным станет на этапе ИИ-фич
  ANTHROPIC_API_KEY: z.string().optional(),

  // Пробный ИИ (SPEC §8.11): наш ключ (внутри DeepSeek — в UI не раскрываем).
  // Бюджет — на КОМПАНИЮ: проектов можно создать сколько угодно, и лимит на
  // проект означал бы столько же раз по столько же долларов.
  AI_TRIAL_PROVIDER: z.string().default('deepseek'),
  AI_TRIAL_MODEL: z.string().default('deepseek-v4-flash'),
  AI_TRIAL_KEY: z.string().optional(),
  AI_TRIAL_BUDGET_USD: z.coerce.number().default(0.5),

  // S3 / Cloudflare R2
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_PUBLIC_BUCKET: z.string().optional(),
  S3_PRIVATE_BUCKET: z.string().optional(),
  S3_PUBLIC_URL: z.string().optional(),

  // Email (SMTP ahasend)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM_EMAIL: z.string().optional(),
  // Куда писать о событиях площадки — пока только о регистрациях.
  // Не задан — писем нет: на локальной машине они только мешают.
  ADMIN_EMAIL: z.string().optional(),
  SMTP_FROM_NAME: z.string().optional(), // отображаемое имя отправителя
  SMTP_REPLY_TO: z.string().optional(), // куда уходят ответы (не на noreply)

  APP_URL: z.string().default('http://localhost:5173'),
})

const parsed = envSchema.safeParse(process.env)
if (!parsed.success) {
  console.error('❌ Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data
export const isProd = env.NODE_ENV === 'production'
