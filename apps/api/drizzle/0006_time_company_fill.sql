-- Время без проекта (v2), часть 2: компания у каждой записи.
--
-- Триггер ставит company_id по проекту при любой записи с проектом. Так все
-- места, которые пишут время, — и в v2, и в v1.0 при откате — остаются
-- правильными, не зная о новой колонке. Переносить запись в другой проект
-- тоже безопасно: компания пересчитается.
CREATE OR REPLACE FUNCTION "time_entries_fill_company"() RETURNS trigger AS $$
BEGIN
  IF NEW."project_id" IS NOT NULL THEN
    SELECT p."company_id" INTO NEW."company_id" FROM "projects" p WHERE p."id" = NEW."project_id";
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "time_entries_fill_company" ON "time_entries";
--> statement-breakpoint
CREATE TRIGGER "time_entries_fill_company"
  BEFORE INSERT OR UPDATE OF "project_id", "company_id" ON "time_entries"
  FOR EACH ROW EXECUTE FUNCTION "time_entries_fill_company"();
--> statement-breakpoint
-- Прошлые записи: компания их проекта.
UPDATE "time_entries" t SET "company_id" = p."company_id"
FROM "projects" p
WHERE p."id" = t."project_id" AND t."company_id" IS NULL;
