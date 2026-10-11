CREATE TYPE "public"."resource_source" AS ENUM('manual', 'chat');--> statement-breakpoint
CREATE TABLE "resource_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"value_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credentials" ALTER COLUMN "value_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "source" "resource_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "resource_secrets" ADD CONSTRAINT "resource_secrets_resource_id_credentials_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_secrets_idx" ON "resource_secrets" USING btree ("resource_id");--> statement-breakpoint
-- backfill: старые одиночные значения кредов → первый секрет ресурса
INSERT INTO "resource_secrets" ("id", "resource_id", "label", "value_encrypted", "created_at")
SELECT md5(random()::text || id), id, 'Value', value_encrypted, created_at
FROM "credentials" WHERE value_encrypted IS NOT NULL;
