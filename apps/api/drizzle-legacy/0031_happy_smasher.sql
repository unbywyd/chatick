CREATE TABLE "bridge_auth_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_code" text NOT NULL,
	"device_code" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" text,
	"project_id" text,
	"client_name" text DEFAULT 'AI assistant' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_auth_codes_user_code_unique" UNIQUE("user_code"),
	CONSTRAINT "bridge_auth_codes_device_code_unique" UNIQUE("device_code")
);
--> statement-breakpoint
CREATE TABLE "bridge_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"client_name" text DEFAULT 'AI assistant' NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "bridge_auth_codes" ADD CONSTRAINT "bridge_auth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_auth_codes" ADD CONSTRAINT "bridge_auth_codes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_sessions" ADD CONSTRAINT "bridge_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_sessions" ADD CONSTRAINT "bridge_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bridge_auth_codes_expiry_idx" ON "bridge_auth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "bridge_sessions_user_idx" ON "bridge_sessions" USING btree ("user_id","revoked_at");