-- Версии проекта (PLAN-RELEASES.md).
--
-- Отвечают на вопрос, который сейчас задают голосом в WhatsApp: «какая версия
-- сейчас в проде». Статус версии живёт отдельно от статуса задачи — у них
-- разные жизненные пути и совпадают они лишь случайно.

-- Что включено в проекте. Отдельная таблица, а не колонка у projects:
-- функций станет больше, и колонка на каждую превратит проект в свалку флагов.
CREATE TABLE IF NOT EXISTS "project_features" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL,
  "feature" text NOT NULL,
  "enabled_by_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "project_features"
  ADD CONSTRAINT "project_features_project_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade;

-- Человек, включивший функцию, мог уйти из компании — сама функция остаётся.
ALTER TABLE "project_features"
  ADD CONSTRAINT "project_features_enabled_by_id_fk"
  FOREIGN KEY ("enabled_by_id") REFERENCES "users"("id") ON DELETE set null;

CREATE UNIQUE INDEX IF NOT EXISTS "project_features_unique"
  ON "project_features" ("project_id", "feature");

CREATE TABLE IF NOT EXISTS "releases" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL,
  "version" text NOT NULL,
  "build_type" text NOT NULL,
  "status" text NOT NULL,
  "owner_id" text,
  "reference_url" text,
  "notes" text,
  "released_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "releases"
  ADD CONSTRAINT "releases_project_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade;

-- Автор версии мог уйти; сама версия и её история остаются.
ALTER TABLE "releases"
  ADD CONSTRAINT "releases_owner_id_fk"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE set null;

CREATE INDEX IF NOT EXISTS "releases_project_idx" ON "releases" ("project_id");
-- Сводка «что сейчас в проде» ходит именно этим ключом.
CREATE INDEX IF NOT EXISTS "releases_project_type_idx" ON "releases" ("project_id", "build_type");

-- Связь с задачами: необязательная с обеих сторон, у одной версии их бывает
-- несколько («собрать билд» и «поднять в магазин» — разная работа разных людей).
CREATE TABLE IF NOT EXISTS "task_releases" (
  "id" text PRIMARY KEY NOT NULL,
  "task_id" text NOT NULL,
  "release_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "task_releases"
  ADD CONSTRAINT "task_releases_task_id_fk"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade;

ALTER TABLE "task_releases"
  ADD CONSTRAINT "task_releases_release_id_fk"
  FOREIGN KEY ("release_id") REFERENCES "releases"("id") ON DELETE cascade;

CREATE INDEX IF NOT EXISTS "task_releases_task_idx" ON "task_releases" ("task_id");
CREATE INDEX IF NOT EXISTS "task_releases_release_idx" ON "task_releases" ("release_id");
CREATE UNIQUE INDEX IF NOT EXISTS "task_releases_unique" ON "task_releases" ("task_id", "release_id");
