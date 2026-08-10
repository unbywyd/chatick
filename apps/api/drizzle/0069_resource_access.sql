-- Доступ к секретам ресурса и связь задачи с ресурсами.
--
-- Секреты до сих пор видел любой, у кого есть resources.manage. Теперь у
-- ресурса есть список зрителей: пароль от прода не обязан быть виден всем,
-- кого позвали в проект.
--
-- Ограничение касается ТОЛЬКО секретов. Ссылка и описание остаются общими:
-- адрес макета — не тайна, и прятать его значит ломать то, ради чего ресурсы
-- заводили.

CREATE TABLE IF NOT EXISTS "resource_viewers" (
  "id" text PRIMARY KEY NOT NULL,
  "resource_id" text NOT NULL REFERENCES "credentials"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "resource_viewers_idx" ON "resource_viewers" ("resource_id");
-- Один человек — одна запись: иначе повторное добавление плодит дубликаты,
-- и снятие доступа убирает лишь один из них, оставляя секрет открытым.
CREATE UNIQUE INDEX IF NOT EXISTS "resource_viewers_unique" ON "resource_viewers" ("resource_id", "user_id");

CREATE TABLE IF NOT EXISTS "task_resources" (
  "id" text PRIMARY KEY NOT NULL,
  "task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE cascade,
  "resource_id" text NOT NULL REFERENCES "credentials"("id") ON DELETE cascade,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "task_resources_task_idx" ON "task_resources" ("task_id");
CREATE INDEX IF NOT EXISTS "task_resources_resource_idx" ON "task_resources" ("resource_id");
CREATE UNIQUE INDEX IF NOT EXISTS "task_resources_unique" ON "task_resources" ("task_id", "resource_id");

-- Существующие ресурсы: доступ у всех участников проекта.
--
-- Пустая таблица означала бы «видит только автор», и завтра утром половина
-- команды потеряла бы доступ к паролям, которыми пользуется каждый день. Новое
-- правило применяется к новым ресурсам; старые остаются как были.
INSERT INTO "resource_viewers" ("id", "resource_id", "user_id")
SELECT
  -- id() в схеме — nanoid из приложения; здесь генерируем совместимый по длине
  -- случайный ключ: строки служебные, снаружи их идентификаторы не видны.
  substr(md5(random()::text || c.id || pm.user_id), 1, 21),
  c.id,
  pm.user_id
FROM "credentials" c
JOIN "project_members" pm ON pm.project_id = c.project_id
WHERE c.deleted_at IS NULL
  -- Автор и так видит всегда — его в списке не держим.
  AND (c.created_by_id IS NULL OR pm.user_id <> c.created_by_id)
ON CONFLICT DO NOTHING;
