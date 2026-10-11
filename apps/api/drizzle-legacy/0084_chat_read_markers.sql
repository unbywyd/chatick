-- Отметки о прочтении по каналам чата.
--
-- Без них «новые сообщения» не посчитать: у сообщений есть автор и время, но
-- нет признака, дошли ли они до конкретного человека. Бейдж на свёрнутом чате
-- и на табах опирается на эти две отметки.
--
-- Nullable без умолчания: заполнять существующие строки «сейчас» значило бы
-- разом объявить прочитанным всё, что человек не видел. Null читается как
-- «не открывал», и первый заход покажет честную картину.
ALTER TABLE "project_members" ADD COLUMN IF NOT EXISTS "last_seen_group_at" timestamptz;
ALTER TABLE "project_members" ADD COLUMN IF NOT EXISTS "last_seen_ai_at" timestamptz;

-- Считаем непрочитанное по (project_id, mode, created_at) на каждое открытие
-- проекта; без индекса это последовательное чтение всей ленты.
CREATE INDEX IF NOT EXISTS "messages_project_mode_created_idx"
  ON "messages" ("project_id", "mode", "created_at");
