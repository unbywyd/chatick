ALTER TABLE "projects" ADD COLUMN "color" text DEFAULT '#6366f1' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "logo_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "logo_key" text;