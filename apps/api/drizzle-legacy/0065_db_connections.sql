-- Подключения к внешним БД (шаг 1: только чтение).
--
-- Три новые таблицы, ничего существующего не трогаем. Фича может не прижиться:
-- снести её — это DROP этих трёх таблиц, без правки чужих данных. Плюс
-- выключатель в окружении: выключено — ручки отвечают 404.

DO $$ BEGIN
  CREATE TYPE "db_connection_kind" AS ENUM ('postgres', 'mysql');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Строка подключения шифруется как секреты ресурсов: в дампе базы её нет.
-- Наружу не отдаётся никогда — только хост и имя базы, чтобы человек видел,
-- куда подключён, и не скопировал пароль в переписку.
CREATE TABLE IF NOT EXISTS "db_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "kind" "db_connection_kind" NOT NULL,
  "host" text DEFAULT '' NOT NULL,
  "database" text DEFAULT '' NOT NULL,
  "dsn_encrypted" text NOT NULL,
  -- Запись выключена по умолчанию. Шаг 1 её не умеет, но колонку заводим
  -- сразу: добавлять её потом — менять таблицу с боевыми подключениями.
  "write_enabled" boolean DEFAULT false NOT NULL,
  "checked_at" timestamp with time zone,
  "last_error" text,
  "created_by_id" text REFERENCES "users"("id") ON DELETE set null,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "db_connections_project_idx" ON "db_connections" ("project_id");

-- Белый список, а не чёрный: таблица, о которой забыли, должна быть
-- НЕдоступна. Схему стягиваем сами, но каждая таблица приходит выключенной.
CREATE TABLE IF NOT EXISTS "db_table_policies" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL REFERENCES "db_connections"("id") ON DELETE cascade,
  "schema_name" text DEFAULT 'public' NOT NULL,
  "table_name" text NOT NULL,
  "can_read" boolean DEFAULT false NOT NULL,
  "can_write" boolean DEFAULT false NOT NULL,
  -- Колонки, которые не отдаём наружу: пароли, токены, персональные данные.
  -- Проверяется и на чтении — иначе «покажи всё из users» выгрузит хеши.
  "hidden_columns" text DEFAULT '[]' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "db_table_policies_uniq_idx"
  ON "db_table_policies" ("connection_id", "schema_name", "table_name");

-- Журнал: кто, что и с каким результатом. Сам запрос пишем, СТРОКИ — нет:
-- в них персональные данные заказчика, копить их у себя мы не вправе.
CREATE TABLE IF NOT EXISTS "db_query_log" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL REFERENCES "db_connections"("id") ON DELETE cascade,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "user_id" text REFERENCES "users"("id") ON DELETE set null,
  "via_bridge" boolean DEFAULT false NOT NULL,
  "kind" text NOT NULL,
  "sql_text" text NOT NULL,
  "row_count" integer,
  "ms" integer,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "db_query_log_conn_idx" ON "db_query_log" ("connection_id", "created_at");
