-- Мягкое удаление комментариев.
--
-- Раньше удаление было физическим: строка исчезала навсегда, и в журнал
-- ничего не писалось. Комментарий пропадал бесследно — оставалось только
-- уведомление о нём, ведущее в задачу, где ничего нет. Ровно так и вышло:
-- человек удалил комментарий в TASK-6 и написал тот же текст в TASK-5, а в
-- инбоксе осталась ссылка в пустоту.
--
-- Теперь как у задач и файлов: строка остаётся, на месте комментария видно
-- «комментарий удалён». Кто и когда — в истории задачи.
ALTER TABLE "task_comments" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "deleted_by_id" text;--> statement-breakpoint

-- Каскад тот же, что у author_id: удаление человека не должно уносить с собой
-- историю обсуждения.
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_deleted_by_id_users_id_fk"
  FOREIGN KEY ("deleted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Живые комментарии задачи читаются на каждом её открытии, и почти все они
-- живые: частичный индекс не тащит удалённые.
CREATE INDEX IF NOT EXISTS "task_comments_alive_idx"
  ON "task_comments" ("task_id", "created_at") WHERE "deleted_at" IS NULL;
