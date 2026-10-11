-- Интеграция проекта с внешней системой сборок (пока Expo/EAS).
--
-- Секрет нужен, чтобы проверять подпись входящих вебхуков: EAS подписывает
-- тело HMAC-SHA1 и шлёт в expo-signature. Без проверки ручка принимала бы что
-- угодно от кого угодно, а она двигает стадии релизов.
--
-- Одна интеграция на проект: аккаунт Expo у команды один, а разные приложения
-- различаются именем сборки, которое приходит в самом вебхуке.
CREATE TABLE IF NOT EXISTS "project_integrations" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL,
  "kind" text NOT NULL,
  "secret" text NOT NULL,
  "last_event_at" timestamp with time zone,
  "created_by_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "project_integrations"
  ADD CONSTRAINT "project_integrations_project_fk"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade;

ALTER TABLE "project_integrations"
  ADD CONSTRAINT "project_integrations_creator_fk"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE set null;

CREATE UNIQUE INDEX IF NOT EXISTS "project_integrations_unique"
  ON "project_integrations" ("project_id", "kind");
