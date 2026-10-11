CREATE TYPE "public"."handoff_action" AS ENUM('create', 'review', 'accept', 'return', 'ask', 'answer', 'pass', 'take', 'wait_client', 'client_replied', 'cancel', 'reopen');--> statement-breakpoint
CREATE TYPE "public"."task_move" AS ENUM('do', 'review', 'answer');--> statement-breakpoint
CREATE TABLE "task_handoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"project_id" text NOT NULL,
	"action" "handoff_action" NOT NULL,
	"actor_id" text,
	"from_id" text,
	"to_id" text,
	"move_before" "task_move",
	"move_after" "task_move",
	"note" text DEFAULT '' NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"via" text DEFAULT 'ui' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "move" "task_move" DEFAULT 'do' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "held_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "ask_from_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "ask_prev_move" "task_move";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "waiting_client_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "on_table" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task_handoffs" ADD CONSTRAINT "task_handoffs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_handoffs" ADD CONSTRAINT "task_handoffs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_handoffs" ADD CONSTRAINT "task_handoffs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_handoffs" ADD CONSTRAINT "task_handoffs_from_id_users_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_handoffs" ADD CONSTRAINT "task_handoffs_to_id_users_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_handoffs_task_idx" ON "task_handoffs" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_handoffs_to_idx" ON "task_handoffs" USING btree ("to_id","created_at");--> statement-breakpoint
CREATE INDEX "task_handoffs_project_idx" ON "task_handoffs" USING btree ("project_id","created_at");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_ask_from_id_users_id_fk" FOREIGN KEY ("ask_from_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_holder_move_idx" ON "tasks" USING btree ("assignee_id","move");--> statement-breakpoint
CREATE INDEX "tasks_owner_idx" ON "tasks" USING btree ("owner_id");