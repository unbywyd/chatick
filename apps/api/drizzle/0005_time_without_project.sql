ALTER TABLE "time_entries" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "company_id" text;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_entries_company_idx" ON "time_entries" USING btree ("company_id","started_at");--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_scope" CHECK ("time_entries"."project_id" is not null or "time_entries"."company_id" is not null);