-- Своё хранилище на уровне компании (SPEC §8.47).
--
-- Настройка была только на проекте: компания с десятком проектов вводила одни
-- и те же ключи R2 десять раз, а при смене ключа — снова десять. Проекты в
-- интерфейсе при этом уже обещали «наследовать от компании», хотя наследовать
-- было не от чего.
--
-- Таблица повторяет project_storage: у компании ровно одна настройка, ключ —
-- сама компания.
CREATE TABLE IF NOT EXISTS "company_storage" (
  "company_id" text PRIMARY KEY NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "provider" "storage_provider" DEFAULT 'platform' NOT NULL,
  "endpoint" text,
  "region" text DEFAULT 'auto' NOT NULL,
  "bucket" text,
  -- Ключи шифруются (AES-256-GCM), как и у проекта: наружу не отдаются никогда.
  "access_key_encrypted" text,
  "secret_key_encrypted" text,
  "public_url" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
