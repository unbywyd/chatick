-- Скриншот к обращению: один снимок экрана заменяет три письма с уточнениями.
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "screenshot_key" text;
