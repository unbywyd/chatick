-- Ассистент компании (v2), часть 2: компания у каждой записи расхода ИИ.
--
-- По компании считается пробный бюджет. Триггер ставит company_id по проекту
-- при любой записи с проектом — старые места записи (и v1.0 при откате)
-- остаются правильными, ничего о колонке не зная.
CREATE OR REPLACE FUNCTION "ai_usage_fill_company"() RETURNS trigger AS $$
BEGIN
  IF NEW."project_id" IS NOT NULL THEN
    SELECT p."company_id" INTO NEW."company_id" FROM "projects" p WHERE p."id" = NEW."project_id";
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ai_usage_fill_company" ON "ai_usage_log";
--> statement-breakpoint
CREATE TRIGGER "ai_usage_fill_company"
  BEFORE INSERT OR UPDATE OF "project_id", "company_id" ON "ai_usage_log"
  FOR EACH ROW EXECUTE FUNCTION "ai_usage_fill_company"();
--> statement-breakpoint
UPDATE "ai_usage_log" u SET "company_id" = p."company_id"
FROM "projects" p
WHERE p."id" = u."project_id" AND u."company_id" IS NULL;
