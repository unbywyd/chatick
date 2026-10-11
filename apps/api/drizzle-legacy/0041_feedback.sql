-- Обратная связь и настройки площадки (SPEC §8.35).

CREATE TYPE feedback_topic AS ENUM ('question', 'bug', 'feature', 'billing', 'other');
CREATE TYPE feedback_status AS ENUM ('new', 'read', 'answered');

CREATE TABLE feedback (
  id         text PRIMARY KEY,
  topic      feedback_topic NOT NULL DEFAULT 'question',
  body       text NOT NULL,
  email      text NOT NULL,
  name       text NOT NULL DEFAULT '',
  user_id    text REFERENCES users(id) ON DELETE SET NULL,
  status     feedback_status NOT NULL DEFAULT 'new',
  meta       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX feedback_status_idx ON feedback (status, created_at);

-- Настройки площадки: ключ-значение, чтобы менять текст без выката сборки.
CREATE TABLE platform_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Значения по умолчанию: страница «О проекте» должна что-то показывать сразу.
INSERT INTO platform_settings (key, value) VALUES
  ('about.text', 'Разработано webtopro.com'),
  ('about.website', 'https://webtopro.com'),
  ('feedback.admins', 'unbywyd@gmail.com')
ON CONFLICT (key) DO NOTHING;
