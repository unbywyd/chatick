-- История стадий версии: кто, когда и почему.
--
-- Отдельная таблица, а не поле у releases: поле хранит только последний
-- комментарий, а ценна лента. «Почему 1.4 неделю висит в ревью Apple» — вопрос
-- из того же ряда, что «какая версия в проде», и ответ на него теряется, если
-- каждый следующий переход затирает предыдущий.
--
-- comment NOT NULL: пустой переход не объясняет ничего, а спросить задним
-- числом уже не у кого.
CREATE TABLE IF NOT EXISTS "release_events" (
  "id" text PRIMARY KEY NOT NULL,
  "release_id" text NOT NULL,
  "status" text NOT NULL,
  "from_status" text,
  "comment" text NOT NULL,
  "actor_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "release_events"
  ADD CONSTRAINT "release_events_release_id_fk"
  FOREIGN KEY ("release_id") REFERENCES "releases"("id") ON DELETE cascade;

-- Человек мог уйти из компании; запись о том, что он сделал, остаётся.
ALTER TABLE "release_events"
  ADD CONSTRAINT "release_events_actor_id_fk"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE set null;

-- Лента одной версии читается по порядку — индекс сразу с датой.
CREATE INDEX IF NOT EXISTS "release_events_release_idx"
  ON "release_events" ("release_id", "created_at");
