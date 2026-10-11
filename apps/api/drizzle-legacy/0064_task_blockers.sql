-- Зависимости между задачами: «эта ждёт ту».
--
-- Одна строка = одна связь: blocked_task_id ЖДЁТ blocker_task_id. Обратное
-- направление («кого держит эта») — тот же список с другой стороны, поэтому
-- второй таблицы нет и рассинхронизироваться нечему.
--
-- Связь переживает закрытие блокирующей задачи: это факт о работе, а не
-- временный флаг. Замочек гаснет сам, когда все блокеры завершены, а история
-- «что чего ждало» остаётся.
CREATE TABLE IF NOT EXISTS "task_blockers" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "blocked_task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE cascade,
  "blocker_task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE cascade,
  "created_by_id" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Одна и та же связь дважды — это не две связи.
CREATE UNIQUE INDEX IF NOT EXISTS "task_blockers_pair_idx"
  ON "task_blockers" ("blocked_task_id", "blocker_task_id");

-- Оба направления читаются одинаково часто: слева «кого я жду», справа «кого
-- держу я». Без второго индекса обратный список шёл бы полным сканом.
CREATE INDEX IF NOT EXISTS "task_blockers_blocked_idx" ON "task_blockers" ("blocked_task_id");
CREATE INDEX IF NOT EXISTS "task_blockers_blocker_idx" ON "task_blockers" ("blocker_task_id");
CREATE INDEX IF NOT EXISTS "task_blockers_project_idx" ON "task_blockers" ("project_id");

-- Задача не может ждать саму себя. Кольца длиннее одного шага ловятся в коде
-- обходом графа — в SQL такое ограничение не выразить.
ALTER TABLE "task_blockers" DROP CONSTRAINT IF EXISTS "task_blockers_no_self";
ALTER TABLE "task_blockers" ADD CONSTRAINT "task_blockers_no_self"
  CHECK ("blocked_task_id" <> "blocker_task_id");
