-- Мастер-подключение: туннель ко всем проектам человека, во всех его компаниях.
--
-- Отдельный признак, а не пустые projectId/companyId: пустота там уже значит
-- «код ещё не подтверждён», и перегружать её вторым смыслом — верный способ
-- когда-нибудь выдать доступ ко всему вместо отказа.
ALTER TABLE "bridge_sessions" ADD COLUMN IF NOT EXISTS "scope_all" boolean NOT NULL DEFAULT false;
ALTER TABLE "bridge_auth_codes" ADD COLUMN IF NOT EXISTS "scope_all" boolean NOT NULL DEFAULT false;
