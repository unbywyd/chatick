-- Ключи API уровня компании (SPEC-INTEGRATION §2).
--
-- Существующие api_tokens привязаны к человеку и умирают вместе с его
-- увольнением. Интеграция принадлежит компании, а не сотруднику, который её
-- настроил, — поэтому отдельная таблица.
CREATE TABLE IF NOT EXISTS "company_api_keys" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  -- «Atlas, продакшн» — чтобы понимать, что отзываешь.
  "name" text NOT NULL,
  -- Сам ключ не хранится: только хеш. Утечка базы не даёт действующих ключей.
  "key_hash" text NOT NULL,
  -- Первые знаки — показать в списке, не раскрывая ключ целиком.
  "prefix" text NOT NULL,
  -- Что разрешено: users:write, projects:write, read:all. JSON-массив.
  "scopes" text NOT NULL DEFAULT '[]',
  -- Необязательный белый список адресов. Пусто — принимаем отовсюду.
  "allowed_ips" text NOT NULL DEFAULT '[]',
  "created_by_id" text REFERENCES "users"("id") ON DELETE set null,
  "last_used_at" timestamp with time zone,
  -- Отзыв мгновенный: проверяется на каждом запросе, а не по истечении срока.
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "company_api_keys_company_idx" ON "company_api_keys" ("company_id");
-- Поиск при каждом запросе идёт по хешу — без индекса это перебор всей таблицы.
CREATE UNIQUE INDEX IF NOT EXISTS "company_api_keys_hash_idx" ON "company_api_keys" ("key_hash");

-- Журнал вызовов извне. Ключ компании даёт много, поэтому видно, кто и что
-- делал: без этого разбор инцидента упирается в «кто-то через API».
CREATE TABLE IF NOT EXISTS "company_api_log" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "key_id" text REFERENCES "company_api_keys"("id") ON DELETE set null,
  "method" text NOT NULL,
  "path" text NOT NULL,
  "status" integer NOT NULL,
  "ip" text NOT NULL DEFAULT '',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "company_api_log_company_idx" ON "company_api_log" ("company_id", "created_at" DESC);

-- Связь с внешней системой на уровне компании и проекта.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "external_system_name" text;
-- Шаблон вида https://atlas.example.com/projects/{externalId} — так переход
-- «к ним» остаётся настройкой, а не кодом под конкретного заказчика.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "external_project_url" text;
-- Проекты создаются только через API: кнопка в интерфейсе исчезает, иначе
-- появятся проекты, которых нет в их системе, и синхронизация посыпется.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "projects_via_api_only" boolean NOT NULL DEFAULT false;

-- Идентификатор проекта в их системе и его имя там же.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "external_id" text;
-- Заказчик зовёт проект по имени клиента, мы — по сути работы. Нужны оба.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "external_name" text;

CREATE UNIQUE INDEX IF NOT EXISTS "projects_external_idx"
  ON "projects" ("company_id", "external_id") WHERE "external_id" IS NOT NULL;

-- То же для людей: их идентификатор — ключ, по которому мы узнаём человека
-- при повторном вызове и не плодим дублей.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "external_id" text;
CREATE INDEX IF NOT EXISTS "users_external_idx" ON "users" ("external_id") WHERE "external_id" IS NOT NULL;
