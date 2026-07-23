CREATE TYPE "public"."credential_action" AS ENUM('reveal', 'create', 'update', 'delete');--> statement-breakpoint
CREATE TABLE "credential_access_log" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"credential_id" text,
	"credential_name" text NOT NULL,
	"user_id" text,
	"action" "credential_action" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "created_by_id" text;--> statement-breakpoint
ALTER TABLE "credential_access_log" ADD CONSTRAINT "credential_access_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_access_log" ADD CONSTRAINT "credential_access_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cred_log_project_created_idx" ON "credential_access_log" USING btree ("project_id","created_at");--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;