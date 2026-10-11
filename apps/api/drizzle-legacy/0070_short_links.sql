-- Короткие ссылки: chatick.com/t-AbC12 вместо адреса на 90 символов.
--
-- Это не публикация: ссылка только ведёт на обычный адрес приложения, дальше
-- решают права. Публичный доступ живёт отдельно, в shares, — там есть отзыв
-- и срок жизни, и смешивать их нельзя.
CREATE TABLE IF NOT EXISTS "short_links" (
  "id" text PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "project_id" text NOT NULL,
  "created_by_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Удалили проект — ссылки уходят с ним, а не остаются вести в никуда.
ALTER TABLE "short_links"
  ADD CONSTRAINT "short_links_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade;

-- Автор мог уйти из компании; ссылка на задачу от этого не должна пропадать.
ALTER TABLE "short_links"
  ADD CONSTRAINT "short_links_created_by_id_users_id_fk"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE set null;

-- Код уникален глобально: по нему и находим, без подсказок о типе.
CREATE UNIQUE INDEX IF NOT EXISTS "short_links_code_idx" ON "short_links" ("code");

-- Одна ссылка на сущность: вторая означала бы два «коротких адреса» у одной
-- задачи, и в переписке они читались бы как две разные задачи.
CREATE UNIQUE INDEX IF NOT EXISTS "short_links_entity_idx" ON "short_links" ("entity_type", "entity_id");

CREATE INDEX IF NOT EXISTS "short_links_project_idx" ON "short_links" ("project_id");
