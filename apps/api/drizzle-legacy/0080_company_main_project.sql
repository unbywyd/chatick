-- Главный проект компании: умолчание для панели в трее.
--
-- Панель открывалась с «Выберите проект» — таймер нельзя было запустить, пока
-- не выберешь, и так на каждой новой машине. Личный выбор хранится в
-- localStorage одного устройства; это умолчание для тех, кто ещё не выбрал.
--
-- Внешний ключ с ON DELETE SET NULL: проект могут удалить, и настройка должна
-- обнулиться сама, а не указывать в пустоту.
--
-- Отдельной колонкой, а не полем в notify_config: то про уведомления, а это
-- про то, где человек работает. Смешав их, пришлось бы разбирать JSON ради
-- одного идентификатора на каждом открытии панели.

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "main_project_id" text;
--> statement-breakpoint
ALTER TABLE "companies" DROP CONSTRAINT IF EXISTS "companies_main_project_id_fk";
--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_main_project_id_fk"
  FOREIGN KEY ("main_project_id") REFERENCES "projects"("id") ON DELETE SET NULL;
