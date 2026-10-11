-- Чек-лист задачи (SPEC §8.37).
--
-- Часто задача — это не одно действие, а список: пройтись по пунктам и
-- отметить. Иногда к пункту нужен ответ («каким ключом подписывать?»), но
-- чаще нет — поэтому заметка необязательна, а галочка есть у каждого пункта.
--
-- Галочки только вручную: ответ и «сделано» — разные вещи. Человек может
-- ответить и не считать пункт закрытым, а может закрыть, ничего не написав.
CREATE TABLE IF NOT EXISTS "task_checklist" (
  "id" text PRIMARY KEY NOT NULL,
  "task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE cascade,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  -- Текст пункта: вопрос или дело.
  "text" text NOT NULL,
  -- Ответ или заметка под пунктом. Пусто — обычное дело.
  "note" text NOT NULL DEFAULT '',
  "done" boolean NOT NULL DEFAULT false,
  -- Кто и когда закрыл: в задаче на несколько человек это первое, что
  -- спрашивают, глядя на закрытый пункт.
  "done_by_id" text REFERENCES "users"("id") ON DELETE set null,
  "done_at" timestamp with time zone,
  -- Порядок задаётся вручную перетаскиванием, как у задач.
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "task_checklist_task_idx" ON "task_checklist" ("task_id", "sort_order");
