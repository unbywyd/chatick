CREATE TYPE "public"."storage_provider" AS ENUM('platform', 'custom');--> statement-breakpoint
CREATE TABLE "project_storage" (
	"project_id" text PRIMARY KEY NOT NULL,
	"provider" "storage_provider" DEFAULT 'platform' NOT NULL,
	"endpoint" text,
	"region" text DEFAULT 'auto' NOT NULL,
	"bucket" text,
	"access_key_encrypted" text,
	"secret_key_encrypted" text,
	"public_url" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_storage" ADD CONSTRAINT "project_storage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;