ALTER TYPE "public"."notification_event" ADD VALUE 'note_mention';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'note_reminder';--> statement-breakpoint
CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"company_id" text,
	"type" text DEFAULT 'note' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"tags" text DEFAULT '[]' NOT NULL,
	"scope" text DEFAULT 'project' NOT NULL,
	"sources" text DEFAULT '[]' NOT NULL,
	"mentioned_ids" text DEFAULT '[]' NOT NULL,
	"remind_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"author_id" text,
	"created_via" text DEFAULT 'ui' NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_deleted_by_id_users_id_fk" FOREIGN KEY ("deleted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notes_project_idx" ON "notes" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "notes_company_idx" ON "notes" USING btree ("company_id","scope");--> statement-breakpoint
CREATE INDEX "notes_remind_idx" ON "notes" USING btree ("remind_at");