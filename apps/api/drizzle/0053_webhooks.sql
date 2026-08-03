-- Вебхуки во внешнюю систему (SPEC-INTEGRATION §7).
--
-- Без них их статистика узнаёт о наших изменениях только опросом: либо она
-- дёргает нас каждую минуту впустую, либо цифры отстают на эту минуту.
-- Событие дешевле и точнее.
CREATE TABLE IF NOT EXISTS "company_webhooks" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "url" text NOT NULL,
  -- Общий секрет: им подписывается каждый запрос, чтобы принимающая сторона
  -- могла убедиться, что это мы, а не кто угодно, узнавший адрес.
  "secret" text NOT NULL,
  -- На какие события слать. Пусто = на все: подписка на всё — обычное начало,
  -- а сужают её потом.
  "events" text NOT NULL DEFAULT '[]',
  "active" boolean NOT NULL DEFAULT true,
  -- Когда последний раз дошло и когда последний раз не дошло: по этой паре
  -- видно живой вебхук или давно сломанный.
  "last_ok_at" timestamp with time zone,
  "last_fail_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "company_webhooks_company_idx" ON "company_webhooks" ("company_id");

-- Очередь доставки. Отдельная таблица, а не отправка на месте: их сервер может
-- лежать, а наш ответ человеку не должен ждать чужую сеть.
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "webhook_id" text NOT NULL REFERENCES "company_webhooks"("id") ON DELETE cascade,
  "event" text NOT NULL,
  "payload" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  -- Когда пробовать снова. Растёт с каждой неудачей: молотить в лежащий сервер
  -- каждую секунду — верный способ добить его и попасть в чёрный список.
  "next_try_at" timestamp with time zone DEFAULT now() NOT NULL,
  "delivered_at" timestamp with time zone,
  "last_status" integer,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Выборка «что пора слать» идёт по этим двум полям на каждом проходе.
CREATE INDEX IF NOT EXISTS "webhook_deliveries_pending_idx"
  ON "webhook_deliveries" ("next_try_at") WHERE "delivered_at" IS NULL;
