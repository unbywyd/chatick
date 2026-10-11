-- Срок задачи: предупреждение заранее + настройки уведомлений у компании.
--
-- Три части одной задумки:
--
-- 1. task_due — новое событие. Срок наступает сам, актора у него нет.
--
-- 2. due_notified_at — метка «уже предупредили». Планировщик тикает каждые
--    5 минут, и без неё человек получал бы напоминание двенадцать раз в час.
--    Сбрасывается в NULL при смене срока (см. setDue в notify-config.ts):
--    перенесли дату — про новую ещё не предупреждали.
--
-- 3. notify_config у компании и у проекта. Раньше уведомления настраивались
--    только в проекте, и правило «о сроках предупреждаем за сутки» заводили в
--    каждом заново. Теперь умолчание живёт у компании, проект может
--    переопределить. Наследование, а не копия при создании — как у
--    time_config: меняя правило, ждут, что оно поменяется везде, а не только
--    в проектах, заведённых после.
--
-- '{}' значит «не задано» и отправляет читателя к компании; поэтому DEFAULT
-- именно пустой объект, а не полный набор умолчаний.
--
-- ALTER TYPE ... ADD VALUE не работает внутри транзакции — отдельным
-- стейтментом до всего остального.

ALTER TYPE "notification_event" ADD VALUE IF NOT EXISTS 'task_due';
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "due_notified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "notify_config" text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "notify_config" text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
-- Задачам с уже прошедшим сроком метку ставим сразу: иначе при первом же тике
-- после выката команда получит пачку писем про сроки, которые все давно знают.
UPDATE "tasks" SET "due_notified_at" = now()
WHERE "due_date" IS NOT NULL AND "due_date" < now() AND "due_notified_at" IS NULL;
