-- Журнал входов под чужим аккаунтом (суффикс «:dev»).
--
-- Такой вход нужен по делу: люди просят «зайди и посмотри», когда у них что-то
-- не работает. Но он открывает чужую переписку и чужие часы, и в обычных логах
-- неотличим от входа самого владельца ящика.
--
-- Отдельной таблицей, а не в activity_log: тот привязан к проекту, а вход
-- происходит до всякого проекта. И терять эти записи в общем потоке нельзя —
-- их читают, когда задают неудобный вопрос.
CREATE TABLE IF NOT EXISTS "support_logins" (
  "id" text PRIMARY KEY NOT NULL,
  -- Кого открывали. Ссылкой без каскада: пользователя могут удалить, а запись
  -- о доступе к его данным обязана пережить удаление.
  "target_user_id" text,
  "target_email" text NOT NULL,
  -- Куда ушёл код — то есть кто фактически входил.
  "sent_to" text NOT NULL,
  "ip" text,
  "user_agent" text,
  -- Код запрошен всегда; отметка ставится, когда им действительно вошли.
  "used_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "support_logins_target_idx" ON "support_logins" ("target_user_id", "created_at" DESC);
