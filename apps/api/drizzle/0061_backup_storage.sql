-- Полноценное отдельное хранилище для бэкапов (SPEC §8.48).
--
-- Раньше можно было указать только имя бакета — ключи и endpoint брались от
-- хранилища файлов. Это половина решения: бэкап имеет смысл держать в ДРУГОМ
-- аккаунте, а лучше и у другого провайдера. Если аккаунт скомпрометирован или
-- заблокирован, копия, лежащая там же, недоступна ровно тогда, когда нужна.
--
-- Отдельная таблица, а не колонки в company_storage: у бэкапа свои ключи,
-- свой endpoint и свой регион — это второе хранилище, а не поле первого.
CREATE TABLE IF NOT EXISTS "company_backup_storage" (
  "company_id" text PRIMARY KEY NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "endpoint" text,
  "region" text DEFAULT 'auto' NOT NULL,
  "bucket" text,
  -- Ключи шифруются (AES-256-GCM) и наружу не отдаются никогда.
  "access_key_encrypted" text,
  "secret_key_encrypted" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Прежнее половинчатое поле больше не нужно: имя бакета переехало в таблицу
-- выше вместе с остальными настройками.
ALTER TABLE "company_storage" DROP COLUMN IF EXISTS "backup_bucket";
