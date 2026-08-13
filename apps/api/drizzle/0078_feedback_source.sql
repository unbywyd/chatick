-- Репорты от ассистента: кто прислал и признак «внедрено».
--
-- ALTER TYPE ... ADD VALUE не работает внутри транзакции, поэтому статус
-- добавляется отдельным стейтментом до всего остального.

ALTER TYPE "feedback_status" ADD VALUE IF NOT EXISTS 'done';
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'human' NOT NULL;
