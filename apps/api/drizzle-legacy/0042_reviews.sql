-- Отзывы с сайта (SPEC §8.37).
-- По умолчанию 'pending': отзыв виден всем, и публиковать его без просмотра
-- значит однажды выпустить на сайт спам от своего же имени.

DO $$ BEGIN
  CREATE TYPE "review_status" AS ENUM('pending', 'published', 'rejected');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "reviews" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "role" text DEFAULT '' NOT NULL,
  "rating" integer DEFAULT 5 NOT NULL,
  "body" text NOT NULL,
  "status" "review_status" DEFAULT 'pending' NOT NULL,
  "user_id" text,
  "meta" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "reviews_status_idx" ON "reviews" ("status", "created_at");
