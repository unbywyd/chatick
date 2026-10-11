ALTER TABLE "files" ADD COLUMN "pending_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "files_pending_idx" ON "files" USING btree ("pending_until");