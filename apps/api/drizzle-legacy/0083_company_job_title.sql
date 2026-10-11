-- Должность и зона ответственности на уровне компании.
--
-- Проект наследует их, пока не задал своё: должность человека не меняется от
-- проекта к проекту, а заводить её в каждом заново значит получить десять
-- расходящихся вариантов. Наследование, а не копия при добавлении в проект —
-- меняя должность у компании, ждут, что она изменится везде.
--
-- Пустая строка, а не NULL: так же, как в project_members, и «не задано»
-- проверяется одинаково в обоих местах.

ALTER TABLE "company_members" ADD COLUMN IF NOT EXISTS "job_title" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "company_members" ADD COLUMN IF NOT EXISTS "responsibility" text NOT NULL DEFAULT '';
