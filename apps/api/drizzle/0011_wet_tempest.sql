ALTER TABLE "projects" ALTER COLUMN "storage_limit" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "storage_limit" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "storage_limit" text DEFAULT '5368709120' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "max_projects" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "max_members" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "plan" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
-- существующие проекты со старым дефолтным лимитом 2GB → наследовать пул компании
UPDATE "projects" SET "storage_limit" = NULL WHERE "storage_limit" = '2147483648';
