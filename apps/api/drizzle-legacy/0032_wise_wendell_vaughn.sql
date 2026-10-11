ALTER TABLE "bridge_sessions" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bridge_auth_codes" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "bridge_sessions" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "bridge_auth_codes" ADD CONSTRAINT "bridge_auth_codes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_sessions" ADD CONSTRAINT "bridge_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;