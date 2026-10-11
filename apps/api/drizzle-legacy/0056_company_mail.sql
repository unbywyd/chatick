-- Своя почта компании: письма уходят с её домена, а не с нашего.
--
-- Компании со своей системой не хотят, чтобы их сотрудники получали письма от
-- чужого бренда — и справедливо: письмо «от Chatick» про их внутренние задачи
-- выглядит как фишинг и попадает в спам, потому что SPF/DKIM нашего домена к
-- их адресу отношения не имеют.
--
-- Пароль SMTP и ключ SendGrid — настоящие секреты: ими шлют почту от имени
-- компании. Лежат зашифрованными (AES-256-GCM, ключ только в .env), наружу
-- не отдаются никогда — ни админу компании, ни в API.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "mail_provider" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "mail_from_email" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "mail_from_name" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "mail_reply_to" text;

-- SMTP
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "mail_host" text;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "mail_port" integer;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "mail_user" text;
-- Шифротекст, а не пароль. Читается только сервером в момент отправки.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "mail_password_enc" text;

-- SendGrid: ключ вместо пары host/user.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "mail_api_key_enc" text;

-- Когда настройки последний раз проверяли живой отправкой. Без этого человек
-- сохраняет пароль с опечаткой и узнаёт об этом от сотрудников, у которых
-- молча перестали приходить письма.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "mail_verified_at" timestamp;
