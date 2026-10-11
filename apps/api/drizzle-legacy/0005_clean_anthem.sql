ALTER TABLE "files" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "sort_order" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_task_idx" ON "files" USING btree ("task_id");