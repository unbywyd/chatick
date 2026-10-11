ALTER TABLE "files" ADD COLUMN "original_key" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "raw_send" boolean DEFAULT false NOT NULL;