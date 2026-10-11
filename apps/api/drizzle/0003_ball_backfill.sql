-- Перевод существующих задач на мяч (v2). Схема — в 0002_ball.
-- Повторный запуск безопасен: каждый шаг трогает только то, что ещё не переведено.

-- 1. Владелец — автор задачи.
UPDATE "tasks" SET "owner_id" = "created_by_id" WHERE "owner_id" IS NULL AND "created_by_id" IS NOT NULL;
--> statement-breakpoint

-- 2. «Ждёт проверки» по большей части висело на исполнителе, сдавшем работу:
-- статус говорил «проверьте», а задача оставалась у того, кто её сделал. Мяч
-- переходит владельцу — если он ещё в команде проекта, иначе остаётся где был.
-- Каждый такой переход оставляет строку в журнале: «почему задача у меня»
-- должно читаться из истории, а не из памяти.
WITH "cand" AS (
  SELECT t."id", t."project_id", t."assignee_id" AS "old_holder", t."owner_id"
  FROM "tasks" t
  WHERE t."status" = 'review'
    AND t."move" = 'do'
    AND t."deleted_at" IS NULL
    AND t."owner_id" IS NOT NULL
    AND t."assignee_id" IS DISTINCT FROM t."owner_id"
    AND EXISTS (
      SELECT 1 FROM "project_members" pm WHERE pm."project_id" = t."project_id" AND pm."user_id" = t."owner_id"
    )
), "moved" AS (
  UPDATE "tasks" t SET "assignee_id" = c."owner_id" FROM "cand" c WHERE t."id" = c."id" RETURNING t."id"
)
INSERT INTO "task_handoffs" ("id", "task_id", "project_id", "action", "actor_id", "from_id", "to_id", "move_before", "move_after", "note", "round", "via")
SELECT 'mig' || substr(md5(c."id" || ':review'), 1, 18), c."id", c."project_id", 'review', NULL, c."old_holder", c."owner_id", 'do', 'review', '', 1, 'migration'
FROM "cand" c
WHERE c."id" IN (SELECT "id" FROM "moved");
--> statement-breakpoint

-- 3. Ход по статусу. После шага 2: ждавшие проверки — «Проверить».
UPDATE "tasks" SET "move" = 'review' WHERE "status" = 'review' AND "move" = 'do';
--> statement-breakpoint

-- 4. «Проверено» больше нет: принять работу — значит закрыть задачу.
UPDATE "tasks" SET "status" = 'done' WHERE "status" = 'verified';
--> statement-breakpoint

-- 5. С какого момента мяч у держателя: последняя смена исполнителя или статуса,
-- иначе — когда задачу трогали в последний раз.
UPDATE "tasks" t SET "held_since" = COALESCE(
  (SELECT max(a."created_at") FROM "activity_log" a
    WHERE a."entity_type" = 'task' AND a."entity_id" = t."id" AND a."action" IN ('create', 'assign', 'status')),
  t."updated_at",
  t."created_at"
)
WHERE t."held_since" IS NULL;
