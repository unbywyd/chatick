CREATE TYPE "public"."ai_source" AS ENUM('company', 'trial', 'custom');--> statement-breakpoint
CREATE TABLE "ai_usage_log" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"source" "ai_source" NOT NULL,
	"model" text NOT NULL,
	"tokens_in" text DEFAULT '0' NOT NULL,
	"tokens_out" text DEFAULT '0' NOT NULL,
	"cost_usd" text,
	"feature" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_pricing" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"model" text NOT NULL,
	"input_per_m" text NOT NULL,
	"output_per_m" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_ai" (
	"project_id" text PRIMARY KEY NOT NULL,
	"source" "ai_source" DEFAULT 'company' NOT NULL,
	"provider" text,
	"model" text,
	"key_encrypted" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD CONSTRAINT "model_pricing_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_ai" ADD CONSTRAINT "project_ai_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_project_idx" ON "ai_usage_log" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "model_pricing_idx" ON "model_pricing" USING btree ("project_id","model");