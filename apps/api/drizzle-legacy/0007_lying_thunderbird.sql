CREATE TYPE "public"."sandbox_role" AS ENUM('user', 'ai');--> statement-breakpoint
CREATE TABLE "sandbox_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"role" "sandbox_role" NOT NULL,
	"text" text NOT NULL,
	"suggestion" boolean DEFAULT false NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "sandbox_messages" ADD CONSTRAINT "sandbox_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_message_idx" ON "sandbox_messages" USING btree ("message_id","created_at");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_message_idx" ON "files" USING btree ("message_id");