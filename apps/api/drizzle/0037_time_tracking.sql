CREATE TABLE "time_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"task_id" text,
	"description" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"auto_stopped" boolean DEFAULT false NOT NULL,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"created_via" text DEFAULT 'ui' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "time_config" text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_entries_project_idx" ON "time_entries" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "time_entries_user_idx" ON "time_entries" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "time_entries_running_idx" ON "time_entries" USING btree ("user_id","ended_at");