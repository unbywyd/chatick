-- Статус «Отменено». Семантика и все места, где он участвует, описаны в
-- документе проекта Chatick «Статус «Отменён»: семантика и все места».
--
-- НА ПРОДЕ — ОТДЕЛЬНЫМ psql-вызовОМ И РАНЬШЕ ДЕПЛОЯ API: код фильтрует
-- `status not in ('done','cancelled')`, и без этого значения в enum Postgres
-- ответит «invalid input value for enum task_status» на каждый список задач.
-- Перед этим — дамп (pg_dump -Fc) и проверка pg_restore -l.
ALTER TYPE "public"."task_status" ADD VALUE 'cancelled';
