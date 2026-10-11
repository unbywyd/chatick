-- Журнал работы: что человек делал и где остановился.
--
-- Зачем отдельная таблица, а не заметки. Заметка — знание: «Cardcom не берёт
-- иностранные карты, лечится вот так». Запись журнала — событие: «доделал
-- вебхук, встал на ретраях, завтра оттуда». Первое ищут годами, второе живёт
-- неделю и ценно только рядом с соседними записями.
--
-- Смешав их, мы утопили бы десяток заметок в тысячах записей журнала — тот же
-- довод, по которому в поиске разведены задачи и заметки (embeddings.ts).
--
-- И проверка на живом: у времени поле description существует и пустует — 7
-- записей из 96, средняя длина 2 символа. Место под рассказ о работе
-- действительно свободно, но пристроить его к учёту часов уже пробовали.
CREATE TABLE IF NOT EXISTS "work_log" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "author_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "body" text NOT NULL DEFAULT '',
  -- draft — виден только автору; published — виден по правам проекта.
  "status" text NOT NULL DEFAULT 'draft',
  -- Момент публикации. Отдельно от created_at: черновик пишут в понедельник,
  -- публикуют в пятницу, и лента должна стоять по второй дате — она отвечает
  -- на вопрос «когда это стало историей».
  "published_at" timestamptz,
  -- Связь с задачей необязательна: «разбирался с окружением» не про задачу.
  -- SET NULL, а не CASCADE: задачу удалили — рассказ о сделанной работе
  -- обязан пережить её, иначе журнал теряет ровно то, ради чего ведётся.
  "task_id" text REFERENCES "tasks"("id") ON DELETE SET NULL,
  "deleted_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

-- Черновик у человека в проекте ОДИН.
--
-- Держит база, а не код: две вкладки создадут второй черновик быстрее, чем
-- проверка в приложении успеет посмотреть на первый. А без этого правило
-- «править можно последнюю запись до публикации» теряет смысл — последнюю из
-- скольки?
--
-- Частичный: опубликованных записей у человека сколько угодно, и удалённые
-- место не занимают.
CREATE UNIQUE INDEX IF NOT EXISTS "work_log_one_draft_idx"
  ON "work_log" ("project_id", "author_id")
  WHERE "status" = 'draft' AND "deleted_at" IS NULL;

-- Лента проекта: по убыванию времени, свежее сверху.
CREATE INDEX IF NOT EXISTS "work_log_project_idx"
  ON "work_log" ("project_id", "created_at" DESC);

-- «Показать только Алекса» и «мои записи» — самый частый отбор, и он же
-- единственный, доступный обычному участнику.
CREATE INDEX IF NOT EXISTS "work_log_author_idx"
  ON "work_log" ("project_id", "author_id", "created_at" DESC);
