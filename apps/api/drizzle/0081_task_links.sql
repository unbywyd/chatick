-- Связанные задачи: из чего выросла и что на неё похоже.
--
-- Отдельная таблица, а не kind в task_blockers: смешав их, пришлось бы всюду
-- фильтровать «блокер или нет», и однажды забудут — тогда «похожая задача»
-- начнёт гасить замочком чужую работу. Блокеры про порядок работ, эта таблица
-- про происхождение и сходство.
--
-- kind: 'derived' — выросла из (направленная, с двух сторон читается по-разному),
--       'related' — связано (симметричная).
--
-- cascade на обе задачи: удалили любую из пары — связь исчезает сама, вторая
-- задача остаётся нетронутой.

CREATE TABLE IF NOT EXISTS "task_links" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "from_task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "to_task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "kind" text NOT NULL DEFAULT 'related',
  "created_by_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Одна и та же связь дважды — это не две связи.
CREATE UNIQUE INDEX IF NOT EXISTS "task_links_pair_idx" ON "task_links" ("from_task_id","to_task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_links_from_idx" ON "task_links" ("from_task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_links_to_idx" ON "task_links" ("to_task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_links_project_idx" ON "task_links" ("project_id");
