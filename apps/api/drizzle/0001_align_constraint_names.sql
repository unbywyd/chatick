-- Имена ограничений — как их называет drizzle.
-- Прежние миграции писались руками и получали имена Postgres (..._fkey); код на имена
-- не ссылается, переименование мгновенное и данных не касается.
ALTER TABLE "public"."companies" RENAME CONSTRAINT "companies_main_project_id_fk" TO "companies_main_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."company_api_keys" RENAME CONSTRAINT "company_api_keys_company_id_fkey" TO "company_api_keys_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."company_api_keys" RENAME CONSTRAINT "company_api_keys_created_by_id_fkey" TO "company_api_keys_created_by_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."company_api_log" RENAME CONSTRAINT "company_api_log_company_id_fkey" TO "company_api_log_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."company_api_log" RENAME CONSTRAINT "company_api_log_key_id_fkey" TO "company_api_log_key_id_company_api_keys_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."company_backup_storage" RENAME CONSTRAINT "company_backup_storage_company_id_fkey" TO "company_backup_storage_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."company_storage" RENAME CONSTRAINT "company_storage_company_id_fkey" TO "company_storage_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."company_webhooks" RENAME CONSTRAINT "company_webhooks_company_id_fkey" TO "company_webhooks_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."db_connections" RENAME CONSTRAINT "db_connections_created_by_id_fkey" TO "db_connections_created_by_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."db_connections" RENAME CONSTRAINT "db_connections_project_id_fkey" TO "db_connections_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."db_query_log" RENAME CONSTRAINT "db_query_log_connection_id_fkey" TO "db_query_log_connection_id_db_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."db_query_log" RENAME CONSTRAINT "db_query_log_project_id_fkey" TO "db_query_log_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."db_query_log" RENAME CONSTRAINT "db_query_log_user_id_fkey" TO "db_query_log_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."db_table_policies" RENAME CONSTRAINT "db_table_policies_connection_id_fkey" TO "db_table_policies_connection_id_db_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."embedding_queue" RENAME CONSTRAINT "embedding_queue_project_id_fkey" TO "embedding_queue_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."embeddings" RENAME CONSTRAINT "embeddings_company_id_fkey" TO "embeddings_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."embeddings" RENAME CONSTRAINT "embeddings_project_id_fkey" TO "embeddings_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."feedback" RENAME CONSTRAINT "feedback_user_id_fkey" TO "feedback_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."notifications" RENAME CONSTRAINT "notifications_company_id_fkey" TO "notifications_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."project_features" RENAME CONSTRAINT "project_features_enabled_by_id_fk" TO "project_features_enabled_by_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."project_features" RENAME CONSTRAINT "project_features_project_id_fk" TO "project_features_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."project_integrations" RENAME CONSTRAINT "project_integrations_creator_fk" TO "project_integrations_created_by_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."project_integrations" RENAME CONSTRAINT "project_integrations_project_fk" TO "project_integrations_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."release_events" RENAME CONSTRAINT "release_events_actor_id_fk" TO "release_events_actor_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."release_events" RENAME CONSTRAINT "release_events_release_id_fk" TO "release_events_release_id_releases_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."releases" RENAME CONSTRAINT "releases_owner_id_fk" TO "releases_owner_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."releases" RENAME CONSTRAINT "releases_project_id_fk" TO "releases_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."resource_files" RENAME CONSTRAINT "resource_files_resource_id_fkey" TO "resource_files_resource_id_credentials_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."resource_files" RENAME CONSTRAINT "resource_files_uploaded_by_id_fkey" TO "resource_files_uploaded_by_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."resource_viewers" RENAME CONSTRAINT "resource_viewers_resource_id_fkey" TO "resource_viewers_resource_id_credentials_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."resource_viewers" RENAME CONSTRAINT "resource_viewers_user_id_fkey" TO "resource_viewers_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."shares" RENAME CONSTRAINT "shares_created_by_id_fkey" TO "shares_created_by_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."shares" RENAME CONSTRAINT "shares_project_id_fkey" TO "shares_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."shares" RENAME CONSTRAINT "shares_slug_key" TO "shares_slug_unique";
--> statement-breakpoint
ALTER TABLE "public"."task_blockers" RENAME CONSTRAINT "task_blockers_blocked_task_id_fkey" TO "task_blockers_blocked_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."task_blockers" RENAME CONSTRAINT "task_blockers_blocker_task_id_fkey" TO "task_blockers_blocker_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."task_blockers" RENAME CONSTRAINT "task_blockers_created_by_id_fkey" TO "task_blockers_created_by_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."task_blockers" RENAME CONSTRAINT "task_blockers_project_id_fkey" TO "task_blockers_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."task_checklist" RENAME CONSTRAINT "task_checklist_done_by_id_fkey" TO "task_checklist_done_by_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."task_checklist" RENAME CONSTRAINT "task_checklist_project_id_fkey" TO "task_checklist_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."task_checklist" RENAME CONSTRAINT "task_checklist_task_id_fkey" TO "task_checklist_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."task_links" RENAME CONSTRAINT "task_links_created_by_id_fkey" TO "task_links_created_by_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."task_links" RENAME CONSTRAINT "task_links_from_task_id_fkey" TO "task_links_from_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."task_links" RENAME CONSTRAINT "task_links_project_id_fkey" TO "task_links_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."task_links" RENAME CONSTRAINT "task_links_to_task_id_fkey" TO "task_links_to_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."task_releases" RENAME CONSTRAINT "task_releases_release_id_fk" TO "task_releases_release_id_releases_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."task_releases" RENAME CONSTRAINT "task_releases_task_id_fk" TO "task_releases_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."task_resources" RENAME CONSTRAINT "task_resources_resource_id_fkey" TO "task_resources_resource_id_credentials_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."task_resources" RENAME CONSTRAINT "task_resources_task_id_fkey" TO "task_resources_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."webhook_deliveries" RENAME CONSTRAINT "webhook_deliveries_webhook_id_fkey" TO "webhook_deliveries_webhook_id_company_webhooks_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."work_log" RENAME CONSTRAINT "work_log_author_id_fkey" TO "work_log_author_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."work_log" RENAME CONSTRAINT "work_log_project_id_fkey" TO "work_log_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."work_log" RENAME CONSTRAINT "work_log_task_id_fkey" TO "work_log_task_id_tasks_id_fk";
