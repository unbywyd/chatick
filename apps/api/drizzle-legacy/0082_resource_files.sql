-- Файлы под ресурсом: кейстор, сертификат, ключ.
--
-- Отдельная таблица от files, а не флаг в ней: флаг однажды забудут в одной
-- из выборок, и ключ подписи окажется в общем файловом менеджере на виду у
-- всего проекта.
--
-- В хранилище лежит шифротекст, не исходник. Ключ шифрования — в .env.
-- Права наследуются от ресурса через resource_viewers.
--
-- cascade: удалили ресурс — записи о файлах ушли вместе с ним. Сами объекты
-- из R2 удаляет код: база о хранилище ничего не знает.

CREATE TABLE IF NOT EXISTS "resource_files" (
  "id" text PRIMARY KEY NOT NULL,
  "resource_id" text NOT NULL REFERENCES "credentials"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "key" text NOT NULL,
  "mime" text NOT NULL DEFAULT 'application/octet-stream',
  "size" text NOT NULL DEFAULT '0',
  "uploaded_by_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_files_idx" ON "resource_files" ("resource_id");
