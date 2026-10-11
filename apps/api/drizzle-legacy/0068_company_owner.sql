-- Кто завёл компанию (SPEC §4.1).
--
-- «Свою» компанию отличали по роли admin — но админом делают и в чужой:
-- человека повысили, и он теряет возможность завести собственную, хотя её
-- у него нет. Роль описывает права внутри пространства, а не принадлежность
-- самого пространства.
--
-- Заполняем задним числом первым админом по времени вступления: он и есть
-- тот, кто компанию создал, — при создании роль admin выдаётся ему одному, а
-- остальные админы появляются позже. Где админов не осталось вовсе (всех
-- убрали), поле останется пустым: выдумывать владельца хуже, чем не знать
-- его — по пустому полю видно, что данных нет.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "created_by_id" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'companies_created_by_id_users_id_fk'
  ) THEN
    ALTER TABLE "companies"
      ADD CONSTRAINT "companies_created_by_id_users_id_fk"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END $$;

UPDATE "companies" c
SET "created_by_id" = first_admin.user_id
FROM (
  SELECT DISTINCT ON (company_id) company_id, user_id
  FROM "company_members"
  WHERE role = 'admin'
  ORDER BY company_id, created_at ASC
) AS first_admin
WHERE c.id = first_admin.company_id
  AND c."created_by_id" IS NULL;
