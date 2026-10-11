-- Приглашение может нести с собой проект: человека добавят туда, как только
-- он примет приглашение. Раньше это было невозможно — участник проекта
-- ссылается на пользователя, а у приглашённого учётной записи ещё нет.

ALTER TABLE "company_invites" ADD COLUMN IF NOT EXISTS "project_id" text;

DO $$ BEGIN
  ALTER TABLE "company_invites" ADD CONSTRAINT "company_invites_project_id_projects_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
