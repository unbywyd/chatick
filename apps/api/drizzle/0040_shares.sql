-- Общий доступ по ссылке (SPEC §8.34).
--
-- Одна таблица на все сущности: файлы, документы, заметки, ресурсы, сообщения,
-- задачи. Публичная ссылка работает без входа, поэтому её можно отозвать —
-- ради этого запись и нужна.

CREATE TYPE share_entity AS ENUM ('file', 'document', 'note', 'resource', 'message', 'task');

CREATE TABLE shares (
  id            text PRIMARY KEY,
  slug          text NOT NULL UNIQUE,
  entity_type   share_entity NOT NULL,
  entity_id     text NOT NULL,
  project_id    text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by_id text REFERENCES users(id) ON DELETE SET NULL,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  views         text NOT NULL DEFAULT '0',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX shares_entity_idx ON shares (entity_type, entity_id);
CREATE INDEX shares_project_idx ON shares (project_id);
