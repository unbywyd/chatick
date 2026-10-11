CREATE TYPE "public"."notification_event" AS ENUM('chat_mention', 'task_mention', 'comment_mention', 'task_assigned', 'task_status', 'task_comment');--> statement-breakpoint
CREATE TYPE "public"."reminder_audience" AS ENUM('all_members', 'assignees');--> statement-breakpoint
CREATE TYPE "public"."reminder_cadence" AS ENUM('hourly', 'daily', 'weekly');--> statement-breakpoint
CREATE TABLE "notification_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"event" "notification_event" NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_opt_outs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"event" "notification_event" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_reminders" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cadence" "reminder_cadence" DEFAULT 'daily' NOT NULL,
	"every_hours" text DEFAULT '3' NOT NULL,
	"hour_of_day" text DEFAULT '9' NOT NULL,
	"day_of_week" text DEFAULT '1' NOT NULL,
	"audience" "reminder_audience" DEFAULT 'all_members' NOT NULL,
	"statuses" text DEFAULT 'todo' NOT NULL,
	"last_sent_at" timestamp with time zone,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_opt_outs" ADD CONSTRAINT "notification_opt_outs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_opt_outs" ADD CONSTRAINT "notification_opt_outs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_reminders" ADD CONSTRAINT "task_reminders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_reminders" ADD CONSTRAINT "task_reminders_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notif_log_dedupe_idx" ON "notification_log" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "notif_optout_idx" ON "notification_opt_outs" USING btree ("user_id","project_id","event");--> statement-breakpoint
CREATE UNIQUE INDEX "task_reminders_project_idx" ON "task_reminders" USING btree ("project_id");