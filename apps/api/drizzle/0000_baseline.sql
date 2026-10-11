-- Точка отсчёта (v2): схема прода на 11.10.2026 — итог 97 прежних миграций (они в drizzle-legacy/).
-- На существующей базе помечается применённой автоматически (src/db/migrate.ts), на пустой — создаёт всё.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
--> statement-breakpoint
CREATE TYPE public.activity_action AS ENUM (
    'create',
    'update',
    'delete',
    'restore',
    'status',
    'assign',
    'comment',
    'upload'
);
--> statement-breakpoint
CREATE TYPE public.ai_source AS ENUM (
    'company',
    'trial',
    'custom'
);
--> statement-breakpoint
CREATE TYPE public.company_role AS ENUM (
    'admin',
    'manager',
    'member'
);
--> statement-breakpoint
CREATE TYPE public.credential_action AS ENUM (
    'reveal',
    'create',
    'update',
    'delete'
);
--> statement-breakpoint
CREATE TYPE public.db_connection_kind AS ENUM (
    'postgres',
    'mysql'
);
--> statement-breakpoint
CREATE TYPE public.feedback_status AS ENUM (
    'new',
    'read',
    'answered',
    'done'
);
--> statement-breakpoint
CREATE TYPE public.feedback_topic AS ENUM (
    'question',
    'bug',
    'feature',
    'billing',
    'other'
);
--> statement-breakpoint
CREATE TYPE public.invite_status AS ENUM (
    'pending',
    'accepted',
    'revoked'
);
--> statement-breakpoint
CREATE TYPE public.member_role AS ENUM (
    'owner',
    'admin',
    'member'
);
--> statement-breakpoint
CREATE TYPE public.message_mode AS ENUM (
    'group',
    'ai'
);
--> statement-breakpoint
CREATE TYPE public.message_status AS ENUM (
    'pending',
    'delivered',
    'held',
    'routed'
);
--> statement-breakpoint
CREATE TYPE public.notification_event AS ENUM (
    'chat_mention',
    'task_mention',
    'comment_mention',
    'task_assigned',
    'task_status',
    'task_comment',
    'note_mention',
    'note_reminder',
    'timer_running',
    'release_status',
    'task_due',
    'checklist_answer',
    'announcement'
);
--> statement-breakpoint
CREATE TYPE public.reminder_audience AS ENUM (
    'all_members',
    'assignees'
);
--> statement-breakpoint
CREATE TYPE public.reminder_cadence AS ENUM (
    'hourly',
    'daily',
    'weekly'
);
--> statement-breakpoint
CREATE TYPE public.resource_source AS ENUM (
    'manual',
    'chat'
);
--> statement-breakpoint
CREATE TYPE public.review_status AS ENUM (
    'pending',
    'published',
    'rejected'
);
--> statement-breakpoint
CREATE TYPE public.sandbox_role AS ENUM (
    'user',
    'ai'
);
--> statement-breakpoint
CREATE TYPE public.share_entity AS ENUM (
    'file',
    'document',
    'note',
    'resource',
    'message',
    'task'
);
--> statement-breakpoint
CREATE TYPE public.storage_provider AS ENUM (
    'platform',
    'custom'
);
--> statement-breakpoint
CREATE TYPE public.task_note_kind AS ENUM (
    'fact',
    'issue',
    'recommendation',
    'rebuttal'
);
--> statement-breakpoint
CREATE TYPE public.task_priority AS ENUM (
    'low',
    'normal',
    'high',
    'urgent'
);
--> statement-breakpoint
CREATE TYPE public.task_status AS ENUM (
    'todo',
    'in_progress',
    'review',
    'verified',
    'done',
    'cancelled'
);
--> statement-breakpoint
CREATE TABLE public.activity_log (
    id text NOT NULL,
    project_id text NOT NULL,
    actor_id text,
    action public.activity_action NOT NULL,
    entity_type text NOT NULL,
    entity_id text,
    entity_label text DEFAULT ''::text NOT NULL,
    meta text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.ai_usage_log (
    id text NOT NULL,
    project_id text NOT NULL,
    source public.ai_source NOT NULL,
    model text NOT NULL,
    tokens_in text DEFAULT '0'::text NOT NULL,
    tokens_out text DEFAULT '0'::text NOT NULL,
    cost_usd text,
    feature text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.api_tokens (
    id text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.bridge_auth_codes (
    id text NOT NULL,
    user_code text NOT NULL,
    device_code text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    user_id text,
    project_id text,
    client_name text DEFAULT 'AI assistant'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    company_id text,
    scope_all boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.bridge_sessions (
    id text NOT NULL,
    token_hash text NOT NULL,
    user_id text NOT NULL,
    project_id text,
    client_name text DEFAULT 'AI assistant'::text NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    company_id text,
    scope_all boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.chat_summaries (
    id text NOT NULL,
    project_id text NOT NULL,
    name text NOT NULL,
    content text NOT NULL,
    from_at timestamp with time zone NOT NULL,
    to_at timestamp with time zone NOT NULL,
    message_count text DEFAULT '0'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.companies (
    id text NOT NULL,
    name text NOT NULL,
    logo_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    llm_provider text,
    llm_model text,
    llm_key_encrypted text,
    storage_limit text DEFAULT '2147483648'::text NOT NULL,
    max_projects text DEFAULT '0'::text NOT NULL,
    max_members text DEFAULT '0'::text NOT NULL,
    plan text DEFAULT 'free'::text NOT NULL,
    is_demo boolean DEFAULT false NOT NULL,
    external_system_name text,
    external_project_url text,
    projects_via_api_only boolean DEFAULT false NOT NULL,
    locale text DEFAULT 'en'::text NOT NULL,
    logo_key text,
    mail_provider text,
    mail_from_email text,
    mail_from_name text,
    mail_reply_to text,
    mail_host text,
    mail_port integer,
    mail_user text,
    mail_password_enc text,
    mail_api_key_enc text,
    mail_verified_at timestamp without time zone,
    members_via_api_only boolean DEFAULT false NOT NULL,
    auto_backup boolean DEFAULT false NOT NULL,
    last_backup_at timestamp with time zone,
    last_backup_error text,
    backup_error_notified_at timestamp with time zone,
    time_config text DEFAULT '{}'::text NOT NULL,
    llm_vision boolean DEFAULT false NOT NULL,
    created_by_id text,
    notify_config text DEFAULT '{}'::text NOT NULL,
    main_project_id text
);
--> statement-breakpoint
CREATE TABLE public.company_api_keys (
    id text NOT NULL,
    company_id text NOT NULL,
    name text NOT NULL,
    key_hash text NOT NULL,
    prefix text NOT NULL,
    scopes text DEFAULT '[]'::text NOT NULL,
    allowed_ips text DEFAULT '[]'::text NOT NULL,
    created_by_id text,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.company_api_log (
    id text NOT NULL,
    company_id text NOT NULL,
    key_id text,
    method text NOT NULL,
    path text NOT NULL,
    status integer NOT NULL,
    ip text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.company_backup_storage (
    company_id text NOT NULL,
    endpoint text,
    region text DEFAULT 'auto'::text NOT NULL,
    bucket text,
    access_key_encrypted text,
    secret_key_encrypted text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.company_invites (
    id text NOT NULL,
    company_id text NOT NULL,
    email text NOT NULL,
    role public.company_role DEFAULT 'member'::public.company_role NOT NULL,
    token text NOT NULL,
    status public.invite_status DEFAULT 'pending'::public.invite_status NOT NULL,
    invited_by_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    project_id text
);
--> statement-breakpoint
CREATE TABLE public.company_members (
    id text NOT NULL,
    company_id text NOT NULL,
    user_id text NOT NULL,
    role public.company_role DEFAULT 'member'::public.company_role NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    job_title text DEFAULT ''::text NOT NULL,
    responsibility text DEFAULT ''::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.company_storage (
    company_id text NOT NULL,
    provider public.storage_provider DEFAULT 'platform'::public.storage_provider NOT NULL,
    endpoint text,
    region text DEFAULT 'auto'::text NOT NULL,
    bucket text,
    access_key_encrypted text,
    secret_key_encrypted text,
    public_url text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.company_webhooks (
    id text NOT NULL,
    company_id text NOT NULL,
    url text NOT NULL,
    secret text NOT NULL,
    events text DEFAULT '[]'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    last_ok_at timestamp with time zone,
    last_fail_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.credential_access_log (
    id text NOT NULL,
    project_id text NOT NULL,
    credential_id text,
    credential_name text NOT NULL,
    user_id text,
    action public.credential_action NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.credentials (
    id text NOT NULL,
    project_id text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    value_encrypted text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_id text,
    url text,
    description text DEFAULT ''::text NOT NULL,
    source public.resource_source DEFAULT 'manual'::public.resource_source NOT NULL,
    message_id text,
    deleted_at timestamp with time zone,
    deleted_by_id text,
    icon text
);
--> statement-breakpoint
CREATE TABLE public.db_connections (
    id text NOT NULL,
    project_id text NOT NULL,
    name text NOT NULL,
    kind public.db_connection_kind NOT NULL,
    host text DEFAULT ''::text NOT NULL,
    database text DEFAULT ''::text NOT NULL,
    dsn_encrypted text NOT NULL,
    write_enabled boolean DEFAULT false NOT NULL,
    checked_at timestamp with time zone,
    last_error text,
    created_by_id text,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.db_query_log (
    id text NOT NULL,
    connection_id text NOT NULL,
    project_id text NOT NULL,
    user_id text,
    via_bridge boolean DEFAULT false NOT NULL,
    kind text NOT NULL,
    sql_text text NOT NULL,
    row_count integer,
    ms integer,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.db_table_policies (
    id text NOT NULL,
    connection_id text NOT NULL,
    schema_name text DEFAULT 'public'::text NOT NULL,
    table_name text NOT NULL,
    can_read boolean DEFAULT false NOT NULL,
    can_write boolean DEFAULT false NOT NULL,
    hidden_columns text DEFAULT '[]'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.document_versions (
    id text NOT NULL,
    document_id text NOT NULL,
    version integer NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    author_id text,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.documents (
    id text NOT NULL,
    project_id text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    public_slug text,
    created_by_id text,
    updated_by_id text,
    deleted_at timestamp with time zone,
    deleted_by_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ycontent text
);
--> statement-breakpoint
CREATE TABLE public.embedding_queue (
    id text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    project_id text,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.embeddings (
    id text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    project_id text,
    company_id text,
    embedding public.vector(512),
    content_hash text NOT NULL,
    model text DEFAULT 'text-embedding-3-small'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.feedback (
    id text NOT NULL,
    topic public.feedback_topic DEFAULT 'question'::public.feedback_topic NOT NULL,
    body text NOT NULL,
    email text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    user_id text,
    status public.feedback_status DEFAULT 'new'::public.feedback_status NOT NULL,
    meta text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    screenshot_key text,
    source text DEFAULT 'human'::text NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.files (
    id text NOT NULL,
    project_id text NOT NULL,
    uploaded_by_id text,
    name text NOT NULL,
    key text NOT NULL,
    mime text DEFAULT 'application/octet-stream'::text NOT NULL,
    size text DEFAULT '0'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    task_id text,
    message_id text,
    original_key text,
    deleted_at timestamp with time zone,
    comment_id text,
    pending_until timestamp with time zone,
    deleted_by_id text
);
--> statement-breakpoint
CREATE TABLE public.messages (
    id text NOT NULL,
    project_id text NOT NULL,
    author_id text,
    mode public.message_mode DEFAULT 'group'::public.message_mode NOT NULL,
    status public.message_status DEFAULT 'pending'::public.message_status NOT NULL,
    text text NOT NULL,
    translations text,
    reply_to_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    raw_send boolean DEFAULT false NOT NULL,
    recipient_id text,
    task_refs text,
    system_event text
);
--> statement-breakpoint
CREATE TABLE public.model_pricing (
    id text NOT NULL,
    project_id text,
    model text NOT NULL,
    input_per_m text NOT NULL,
    output_per_m text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.notes (
    id text NOT NULL,
    project_id text,
    company_id text NOT NULL,
    type text DEFAULT 'note'::text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    tags text DEFAULT '[]'::text NOT NULL,
    scope text DEFAULT 'project'::text NOT NULL,
    sources text DEFAULT '[]'::text NOT NULL,
    mentioned_ids text DEFAULT '[]'::text NOT NULL,
    remind_at timestamp with time zone,
    reminded_at timestamp with time zone,
    author_id text,
    created_via text DEFAULT 'ui'::text NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    task_id text
);
--> statement-breakpoint
CREATE TABLE public.notification_log (
    id text NOT NULL,
    user_id text NOT NULL,
    project_id text NOT NULL,
    event public.notification_event NOT NULL,
    dedupe_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.notification_opt_outs (
    id text NOT NULL,
    user_id text NOT NULL,
    project_id text NOT NULL,
    event public.notification_event NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.notifications (
    id text NOT NULL,
    user_id text NOT NULL,
    project_id text,
    event public.notification_event NOT NULL,
    actor_id text,
    title text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    link text DEFAULT ''::text NOT NULL,
    entity_type text,
    entity_id text,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    summary text,
    company_id text
);
--> statement-breakpoint
CREATE TABLE public.platform_settings (
    key text NOT NULL,
    value text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.project_ai (
    project_id text NOT NULL,
    source public.ai_source DEFAULT 'trial'::public.ai_source NOT NULL,
    provider text,
    model text,
    key_encrypted text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.project_features (
    id text NOT NULL,
    project_id text NOT NULL,
    feature text NOT NULL,
    enabled_by_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.project_integrations (
    id text NOT NULL,
    project_id text NOT NULL,
    kind text NOT NULL,
    secret text NOT NULL,
    last_event_at timestamp with time zone,
    created_by_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.project_members (
    id text NOT NULL,
    project_id text NOT NULL,
    user_id text NOT NULL,
    role public.member_role DEFAULT 'member'::public.member_role NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rules_accepted_at timestamp with time zone,
    permissions text DEFAULT '{}'::text NOT NULL,
    job_title text DEFAULT ''::text NOT NULL,
    responsibility text DEFAULT ''::text NOT NULL,
    last_seen_group_at timestamp with time zone,
    last_seen_ai_at timestamp with time zone,
    hidden_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.project_storage (
    project_id text NOT NULL,
    provider public.storage_provider DEFAULT 'platform'::public.storage_provider NOT NULL,
    endpoint text,
    region text DEFAULT 'auto'::text NOT NULL,
    bucket text,
    access_key_encrypted text,
    secret_key_encrypted text,
    public_url text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.projects (
    id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    about text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    company_id text NOT NULL,
    ai_config text DEFAULT '{}'::text NOT NULL,
    chat_rules text DEFAULT ''::text NOT NULL,
    last_summarized_at timestamp with time zone,
    storage_limit text,
    color text DEFAULT '#6366f1'::text NOT NULL,
    logo_url text,
    logo_key text,
    time_config text DEFAULT '{}'::text NOT NULL,
    external_id text,
    external_name text,
    locale text,
    deadline timestamp with time zone,
    notify_config text DEFAULT '{}'::text NOT NULL,
    archived_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.release_events (
    id text NOT NULL,
    release_id text NOT NULL,
    status text NOT NULL,
    from_status text,
    comment text NOT NULL,
    actor_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.releases (
    id text NOT NULL,
    project_id text NOT NULL,
    version text NOT NULL,
    build_type text NOT NULL,
    status text NOT NULL,
    owner_id text,
    reference_url text,
    notes text,
    released_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    build_profile text,
    app_name text,
    build_page_url text
);
--> statement-breakpoint
CREATE TABLE public.resource_files (
    id text NOT NULL,
    resource_id text NOT NULL,
    name text NOT NULL,
    key text NOT NULL,
    mime text DEFAULT 'application/octet-stream'::text NOT NULL,
    size text DEFAULT '0'::text NOT NULL,
    uploaded_by_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.resource_secrets (
    id text NOT NULL,
    resource_id text NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    value_encrypted text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.resource_viewers (
    id text NOT NULL,
    resource_id text NOT NULL,
    user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.reviews (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    role text DEFAULT ''::text NOT NULL,
    rating integer DEFAULT 5 NOT NULL,
    body text NOT NULL,
    status public.review_status DEFAULT 'pending'::public.review_status NOT NULL,
    user_id text,
    meta text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.sandbox_messages (
    id text NOT NULL,
    message_id text NOT NULL,
    role public.sandbox_role NOT NULL,
    text text NOT NULL,
    suggestion boolean DEFAULT false NOT NULL,
    approved boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text,
    payload text,
    applied_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.shares (
    id text NOT NULL,
    slug text NOT NULL,
    entity_type public.share_entity NOT NULL,
    entity_id text NOT NULL,
    project_id text NOT NULL,
    created_by_id text,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    views text DEFAULT '0'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.short_links (
    id text NOT NULL,
    code text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    project_id text NOT NULL,
    created_by_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.spend_alerts (
    id text NOT NULL,
    period text NOT NULL,
    kind text DEFAULT 'monthly_threshold'::text NOT NULL,
    amount_usd text NOT NULL,
    sent_to text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.support_logins (
    id text NOT NULL,
    target_user_id text,
    target_email text NOT NULL,
    sent_to text NOT NULL,
    ip text,
    user_agent text,
    used_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.task_blockers (
    id text NOT NULL,
    project_id text NOT NULL,
    blocked_task_id text NOT NULL,
    blocker_task_id text NOT NULL,
    created_by_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_blockers_no_self CHECK ((blocked_task_id <> blocker_task_id))
);
--> statement-breakpoint
CREATE TABLE public.task_checklist (
    id text NOT NULL,
    task_id text NOT NULL,
    project_id text NOT NULL,
    text text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    done boolean DEFAULT false NOT NULL,
    done_by_id text,
    done_at timestamp with time zone,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.task_comments (
    id text NOT NULL,
    task_id text NOT NULL,
    project_id text NOT NULL,
    author_id text,
    body text NOT NULL,
    reply_to_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by_id text
);
--> statement-breakpoint
CREATE TABLE public.task_groups (
    id text NOT NULL,
    project_id text NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#64748b'::text NOT NULL,
    sort_order double precision DEFAULT 0 NOT NULL,
    created_by_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by_id text
);
--> statement-breakpoint
CREATE TABLE public.task_links (
    id text NOT NULL,
    project_id text NOT NULL,
    from_task_id text NOT NULL,
    to_task_id text NOT NULL,
    kind text DEFAULT 'related'::text NOT NULL,
    created_by_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.task_notes (
    id text NOT NULL,
    task_id text NOT NULL,
    project_id text NOT NULL,
    kind public.task_note_kind NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.task_releases (
    id text NOT NULL,
    task_id text NOT NULL,
    release_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.task_reminders (
    id text NOT NULL,
    project_id text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    cadence public.reminder_cadence DEFAULT 'daily'::public.reminder_cadence NOT NULL,
    every_hours text DEFAULT '3'::text NOT NULL,
    hour_of_day text DEFAULT '9'::text NOT NULL,
    day_of_week text DEFAULT '1'::text NOT NULL,
    audience public.reminder_audience DEFAULT 'all_members'::public.reminder_audience NOT NULL,
    statuses text DEFAULT 'todo'::text NOT NULL,
    last_sent_at timestamp with time zone,
    created_by_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.task_resources (
    id text NOT NULL,
    task_id text NOT NULL,
    resource_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.tasks (
    id text NOT NULL,
    project_id text NOT NULL,
    number text NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    status public.task_status DEFAULT 'todo'::public.task_status NOT NULL,
    assignee_id text,
    created_by_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    priority public.task_priority DEFAULT 'normal'::public.task_priority NOT NULL,
    due_date timestamp with time zone,
    sort_order double precision DEFAULT 0 NOT NULL,
    group_id text,
    estimate_minutes text,
    deleted_at timestamp with time zone,
    deleted_by_id text,
    refs text DEFAULT ''::text NOT NULL,
    due_notified_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.time_entries (
    id text NOT NULL,
    project_id text NOT NULL,
    user_id text NOT NULL,
    task_id text,
    description text DEFAULT ''::text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    auto_stopped boolean DEFAULT false NOT NULL,
    reminders_sent integer DEFAULT 0 NOT NULL,
    created_via text DEFAULT 'ui'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.user_notification_prefs (
    user_id text NOT NULL,
    daily_digest boolean DEFAULT true NOT NULL,
    digest_hour_utc text DEFAULT '9'::text NOT NULL,
    last_digest_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.users (
    id text NOT NULL,
    email text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    phone text,
    locale text DEFAULT 'en'::text NOT NULL,
    password_hash text,
    is_admin boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    google_id text,
    avatar_url text,
    avatar_key text,
    external_id text,
    locale_set_by_user boolean DEFAULT false NOT NULL,
    tour_seen_at timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE public.webhook_deliveries (
    id text NOT NULL,
    webhook_id text NOT NULL,
    event text NOT NULL,
    payload text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_try_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    last_status integer,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE public.work_log (
    id text NOT NULL,
    project_id text NOT NULL,
    author_id text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    published_at timestamp with time zone,
    task_id text,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.ai_usage_log
    ADD CONSTRAINT ai_usage_log_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.bridge_auth_codes
    ADD CONSTRAINT bridge_auth_codes_device_code_unique UNIQUE (device_code);
--> statement-breakpoint
ALTER TABLE ONLY public.bridge_auth_codes
    ADD CONSTRAINT bridge_auth_codes_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.bridge_auth_codes
    ADD CONSTRAINT bridge_auth_codes_user_code_unique UNIQUE (user_code);
--> statement-breakpoint
ALTER TABLE ONLY public.bridge_sessions
    ADD CONSTRAINT bridge_sessions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.bridge_sessions
    ADD CONSTRAINT bridge_sessions_token_hash_unique UNIQUE (token_hash);
--> statement-breakpoint
ALTER TABLE ONLY public.chat_summaries
    ADD CONSTRAINT chat_summaries_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.company_api_keys
    ADD CONSTRAINT company_api_keys_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.company_api_log
    ADD CONSTRAINT company_api_log_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.company_backup_storage
    ADD CONSTRAINT company_backup_storage_pkey PRIMARY KEY (company_id);
--> statement-breakpoint
ALTER TABLE ONLY public.company_invites
    ADD CONSTRAINT company_invites_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.company_invites
    ADD CONSTRAINT company_invites_token_unique UNIQUE (token);
--> statement-breakpoint
ALTER TABLE ONLY public.company_members
    ADD CONSTRAINT company_members_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.company_storage
    ADD CONSTRAINT company_storage_pkey PRIMARY KEY (company_id);
--> statement-breakpoint
ALTER TABLE ONLY public.company_webhooks
    ADD CONSTRAINT company_webhooks_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.credential_access_log
    ADD CONSTRAINT credential_access_log_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.credentials
    ADD CONSTRAINT credentials_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.db_connections
    ADD CONSTRAINT db_connections_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.db_query_log
    ADD CONSTRAINT db_query_log_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.db_table_policies
    ADD CONSTRAINT db_table_policies_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_public_slug_unique UNIQUE (public_slug);
--> statement-breakpoint
ALTER TABLE ONLY public.embedding_queue
    ADD CONSTRAINT embedding_queue_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.embeddings
    ADD CONSTRAINT embeddings_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.feedback
    ADD CONSTRAINT feedback_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.model_pricing
    ADD CONSTRAINT model_pricing_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.notification_log
    ADD CONSTRAINT notification_log_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.notification_opt_outs
    ADD CONSTRAINT notification_opt_outs_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.platform_settings
    ADD CONSTRAINT platform_settings_pkey PRIMARY KEY (key);
--> statement-breakpoint
ALTER TABLE ONLY public.project_ai
    ADD CONSTRAINT project_ai_pkey PRIMARY KEY (project_id);
--> statement-breakpoint
ALTER TABLE ONLY public.project_features
    ADD CONSTRAINT project_features_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.project_integrations
    ADD CONSTRAINT project_integrations_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.project_storage
    ADD CONSTRAINT project_storage_pkey PRIMARY KEY (project_id);
--> statement-breakpoint
ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_slug_unique UNIQUE (slug);
--> statement-breakpoint
ALTER TABLE ONLY public.release_events
    ADD CONSTRAINT release_events_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.releases
    ADD CONSTRAINT releases_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.resource_files
    ADD CONSTRAINT resource_files_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.resource_secrets
    ADD CONSTRAINT resource_secrets_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.resource_viewers
    ADD CONSTRAINT resource_viewers_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.sandbox_messages
    ADD CONSTRAINT sandbox_messages_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.shares
    ADD CONSTRAINT shares_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.shares
    ADD CONSTRAINT shares_slug_key UNIQUE (slug);
--> statement-breakpoint
ALTER TABLE ONLY public.short_links
    ADD CONSTRAINT short_links_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.spend_alerts
    ADD CONSTRAINT spend_alerts_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.support_logins
    ADD CONSTRAINT support_logins_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.task_blockers
    ADD CONSTRAINT task_blockers_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.task_checklist
    ADD CONSTRAINT task_checklist_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.task_comments
    ADD CONSTRAINT task_comments_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.task_groups
    ADD CONSTRAINT task_groups_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.task_links
    ADD CONSTRAINT task_links_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.task_notes
    ADD CONSTRAINT task_notes_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.task_releases
    ADD CONSTRAINT task_releases_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.task_reminders
    ADD CONSTRAINT task_reminders_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.task_resources
    ADD CONSTRAINT task_resources_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.time_entries
    ADD CONSTRAINT time_entries_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.user_notification_prefs
    ADD CONSTRAINT user_notification_prefs_pkey PRIMARY KEY (user_id);
--> statement-breakpoint
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE ONLY public.work_log
    ADD CONSTRAINT work_log_pkey PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX activity_entity_idx ON public.activity_log USING btree (entity_type, entity_id);
--> statement-breakpoint
CREATE INDEX activity_project_created_idx ON public.activity_log USING btree (project_id, created_at);
--> statement-breakpoint
CREATE INDEX ai_usage_project_idx ON public.ai_usage_log USING btree (project_id, created_at);
--> statement-breakpoint
CREATE INDEX api_tokens_user_idx ON public.api_tokens USING btree (user_id);
--> statement-breakpoint
CREATE INDEX bridge_auth_codes_expiry_idx ON public.bridge_auth_codes USING btree (expires_at);
--> statement-breakpoint
CREATE INDEX bridge_sessions_user_idx ON public.bridge_sessions USING btree (user_id, revoked_at);
--> statement-breakpoint
CREATE INDEX chat_summaries_project_idx ON public.chat_summaries USING btree (project_id, to_at);
--> statement-breakpoint
CREATE INDEX companies_is_demo_idx ON public.companies USING btree (is_demo) WHERE is_demo;
--> statement-breakpoint
CREATE INDEX company_api_keys_company_idx ON public.company_api_keys USING btree (company_id);
--> statement-breakpoint
CREATE UNIQUE INDEX company_api_keys_hash_idx ON public.company_api_keys USING btree (key_hash);
--> statement-breakpoint
CREATE INDEX company_api_log_company_idx ON public.company_api_log USING btree (company_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX company_invites_company_idx ON public.company_invites USING btree (company_id);
--> statement-breakpoint
CREATE INDEX company_invites_email_idx ON public.company_invites USING btree (email);
--> statement-breakpoint
CREATE UNIQUE INDEX company_members_uniq ON public.company_members USING btree (company_id, user_id);
--> statement-breakpoint
CREATE INDEX company_members_user_idx ON public.company_members USING btree (user_id);
--> statement-breakpoint
CREATE INDEX company_webhooks_company_idx ON public.company_webhooks USING btree (company_id);
--> statement-breakpoint
CREATE INDEX cred_log_project_created_idx ON public.credential_access_log USING btree (project_id, created_at);
--> statement-breakpoint
CREATE INDEX credentials_project_idx ON public.credentials USING btree (project_id);
--> statement-breakpoint
CREATE INDEX db_connections_project_idx ON public.db_connections USING btree (project_id);
--> statement-breakpoint
CREATE INDEX db_query_log_conn_idx ON public.db_query_log USING btree (connection_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX db_table_policies_uniq_idx ON public.db_table_policies USING btree (connection_id, schema_name, table_name);
--> statement-breakpoint
CREATE INDEX document_versions_doc_idx ON public.document_versions USING btree (document_id, version);
--> statement-breakpoint
CREATE INDEX documents_project_idx ON public.documents USING btree (project_id, updated_at);
--> statement-breakpoint
CREATE UNIQUE INDEX embedding_queue_entity_idx ON public.embedding_queue USING btree (entity_type, entity_id);
--> statement-breakpoint
CREATE INDEX embedding_queue_pick_idx ON public.embedding_queue USING btree (attempts, created_at);
--> statement-breakpoint
CREATE INDEX embeddings_company_idx ON public.embeddings USING btree (company_id);
--> statement-breakpoint
CREATE UNIQUE INDEX embeddings_entity_idx ON public.embeddings USING btree (entity_type, entity_id);
--> statement-breakpoint
CREATE INDEX embeddings_vec_idx ON public.embeddings USING hnsw (embedding public.vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX feedback_status_idx ON public.feedback USING btree (status, created_at);
--> statement-breakpoint
CREATE INDEX files_message_idx ON public.files USING btree (message_id);
--> statement-breakpoint
CREATE INDEX files_pending_idx ON public.files USING btree (pending_until);
--> statement-breakpoint
CREATE INDEX files_project_idx ON public.files USING btree (project_id);
--> statement-breakpoint
CREATE INDEX files_task_idx ON public.files USING btree (task_id);
--> statement-breakpoint
CREATE INDEX messages_project_created_idx ON public.messages USING btree (project_id, created_at);
--> statement-breakpoint
CREATE INDEX messages_project_mode_created_idx ON public.messages USING btree (project_id, mode, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX model_pricing_idx ON public.model_pricing USING btree (project_id, model);
--> statement-breakpoint
CREATE INDEX notes_company_idx ON public.notes USING btree (company_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX notes_project_idx ON public.notes USING btree (project_id, created_at);
--> statement-breakpoint
CREATE INDEX notes_project_idx2 ON public.notes USING btree (project_id) WHERE (project_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX notes_remind_idx ON public.notes USING btree (remind_at);
--> statement-breakpoint
CREATE UNIQUE INDEX notif_log_dedupe_idx ON public.notification_log USING btree (dedupe_key);
--> statement-breakpoint
CREATE UNIQUE INDEX notif_optout_idx ON public.notification_opt_outs USING btree (user_id, project_id, event);
--> statement-breakpoint
CREATE INDEX notifications_company_idx ON public.notifications USING btree (company_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX notifications_user_created_idx ON public.notifications USING btree (user_id, created_at);
--> statement-breakpoint
CREATE INDEX notifications_user_read_idx ON public.notifications USING btree (user_id, read_at);
--> statement-breakpoint
CREATE UNIQUE INDEX project_features_unique ON public.project_features USING btree (project_id, feature);
--> statement-breakpoint
CREATE UNIQUE INDEX project_integrations_unique ON public.project_integrations USING btree (project_id, kind);
--> statement-breakpoint
CREATE INDEX project_members_hidden_idx ON public.project_members USING btree (user_id, hidden_at);
--> statement-breakpoint
CREATE UNIQUE INDEX project_members_uniq ON public.project_members USING btree (project_id, user_id);
--> statement-breakpoint
CREATE INDEX project_members_user_idx ON public.project_members USING btree (user_id);
--> statement-breakpoint
CREATE INDEX projects_active_idx ON public.projects USING btree (company_id) WHERE (archived_at IS NULL);
--> statement-breakpoint
CREATE INDEX projects_company_idx ON public.projects USING btree (company_id);
--> statement-breakpoint
CREATE UNIQUE INDEX projects_company_name_uniq ON public.projects USING btree (company_id, lower(name));
--> statement-breakpoint
CREATE UNIQUE INDEX projects_external_idx ON public.projects USING btree (company_id, external_id) WHERE (external_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX release_events_release_idx ON public.release_events USING btree (release_id, created_at);
--> statement-breakpoint
CREATE INDEX releases_project_app_type_idx ON public.releases USING btree (project_id, app_name, build_type);
--> statement-breakpoint
CREATE INDEX releases_project_idx ON public.releases USING btree (project_id);
--> statement-breakpoint
CREATE INDEX resource_files_idx ON public.resource_files USING btree (resource_id);
--> statement-breakpoint
CREATE INDEX resource_secrets_idx ON public.resource_secrets USING btree (resource_id);
--> statement-breakpoint
CREATE INDEX resource_viewers_idx ON public.resource_viewers USING btree (resource_id);
--> statement-breakpoint
CREATE UNIQUE INDEX resource_viewers_unique ON public.resource_viewers USING btree (resource_id, user_id);
--> statement-breakpoint
CREATE INDEX reviews_status_idx ON public.reviews USING btree (status, created_at);
--> statement-breakpoint
CREATE INDEX sandbox_message_idx ON public.sandbox_messages USING btree (message_id, created_at);
--> statement-breakpoint
CREATE INDEX shares_entity_idx ON public.shares USING btree (entity_type, entity_id);
--> statement-breakpoint
CREATE INDEX shares_project_idx ON public.shares USING btree (project_id);
--> statement-breakpoint
CREATE UNIQUE INDEX short_links_code_idx ON public.short_links USING btree (code);
--> statement-breakpoint
CREATE UNIQUE INDEX short_links_entity_idx ON public.short_links USING btree (entity_type, entity_id);
--> statement-breakpoint
CREATE INDEX short_links_project_idx ON public.short_links USING btree (project_id);
--> statement-breakpoint
CREATE UNIQUE INDEX spend_alerts_period_idx ON public.spend_alerts USING btree (period, kind);
--> statement-breakpoint
CREATE INDEX support_logins_target_idx ON public.support_logins USING btree (target_user_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX task_blockers_blocked_idx ON public.task_blockers USING btree (blocked_task_id);
--> statement-breakpoint
CREATE INDEX task_blockers_blocker_idx ON public.task_blockers USING btree (blocker_task_id);
--> statement-breakpoint
CREATE UNIQUE INDEX task_blockers_pair_idx ON public.task_blockers USING btree (blocked_task_id, blocker_task_id);
--> statement-breakpoint
CREATE INDEX task_blockers_project_idx ON public.task_blockers USING btree (project_id);
--> statement-breakpoint
CREATE INDEX task_checklist_task_idx ON public.task_checklist USING btree (task_id, sort_order);
--> statement-breakpoint
CREATE INDEX task_comments_alive_idx ON public.task_comments USING btree (task_id, created_at) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE INDEX task_comments_task_idx ON public.task_comments USING btree (task_id, created_at);
--> statement-breakpoint
CREATE INDEX task_groups_project_idx ON public.task_groups USING btree (project_id, sort_order);
--> statement-breakpoint
CREATE INDEX task_links_from_idx ON public.task_links USING btree (from_task_id);
--> statement-breakpoint
CREATE UNIQUE INDEX task_links_pair_idx ON public.task_links USING btree (from_task_id, to_task_id);
--> statement-breakpoint
CREATE INDEX task_links_project_idx ON public.task_links USING btree (project_id);
--> statement-breakpoint
CREATE INDEX task_links_to_idx ON public.task_links USING btree (to_task_id);
--> statement-breakpoint
CREATE INDEX task_notes_task_idx ON public.task_notes USING btree (task_id, created_at);
--> statement-breakpoint
CREATE INDEX task_releases_release_idx ON public.task_releases USING btree (release_id);
--> statement-breakpoint
CREATE INDEX task_releases_task_idx ON public.task_releases USING btree (task_id);
--> statement-breakpoint
CREATE UNIQUE INDEX task_releases_unique ON public.task_releases USING btree (task_id, release_id);
--> statement-breakpoint
CREATE UNIQUE INDEX task_reminders_project_idx ON public.task_reminders USING btree (project_id);
--> statement-breakpoint
CREATE INDEX task_resources_resource_idx ON public.task_resources USING btree (resource_id);
--> statement-breakpoint
CREATE INDEX task_resources_task_idx ON public.task_resources USING btree (task_id);
--> statement-breakpoint
CREATE UNIQUE INDEX task_resources_unique ON public.task_resources USING btree (task_id, resource_id);
--> statement-breakpoint
CREATE INDEX tasks_assignee_idx ON public.tasks USING btree (assignee_id);
--> statement-breakpoint
CREATE INDEX tasks_deleted_idx ON public.tasks USING btree (deleted_at);
--> statement-breakpoint
CREATE INDEX tasks_group_idx ON public.tasks USING btree (group_id);
--> statement-breakpoint
CREATE UNIQUE INDEX tasks_project_number_idx ON public.tasks USING btree (project_id, number);
--> statement-breakpoint
CREATE INDEX tasks_project_status_idx ON public.tasks USING btree (project_id, status);
--> statement-breakpoint
CREATE INDEX time_entries_project_idx ON public.time_entries USING btree (project_id, started_at);
--> statement-breakpoint
CREATE INDEX time_entries_running_idx ON public.time_entries USING btree (user_id, ended_at);
--> statement-breakpoint
CREATE INDEX time_entries_user_idx ON public.time_entries USING btree (user_id, started_at);
--> statement-breakpoint
CREATE UNIQUE INDEX users_email_idx ON public.users USING btree (email);
--> statement-breakpoint
CREATE INDEX users_external_idx ON public.users USING btree (external_id) WHERE (external_id IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX users_google_idx ON public.users USING btree (google_id);
--> statement-breakpoint
CREATE INDEX webhook_deliveries_pending_idx ON public.webhook_deliveries USING btree (next_try_at) WHERE (delivered_at IS NULL);
--> statement-breakpoint
CREATE INDEX work_log_author_idx ON public.work_log USING btree (project_id, author_id, created_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX work_log_one_draft_idx ON public.work_log USING btree (project_id, author_id) WHERE ((status = 'draft'::text) AND (deleted_at IS NULL));
--> statement-breakpoint
CREATE INDEX work_log_project_idx ON public.work_log USING btree (project_id, created_at DESC);
--> statement-breakpoint
ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_actor_id_users_id_fk FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.ai_usage_log
    ADD CONSTRAINT ai_usage_log_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.bridge_auth_codes
    ADD CONSTRAINT bridge_auth_codes_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.bridge_auth_codes
    ADD CONSTRAINT bridge_auth_codes_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.bridge_auth_codes
    ADD CONSTRAINT bridge_auth_codes_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.bridge_sessions
    ADD CONSTRAINT bridge_sessions_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.bridge_sessions
    ADD CONSTRAINT bridge_sessions_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.bridge_sessions
    ADD CONSTRAINT bridge_sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.chat_summaries
    ADD CONSTRAINT chat_summaries_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_created_by_id_users_id_fk FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_main_project_id_fk FOREIGN KEY (main_project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.company_api_keys
    ADD CONSTRAINT company_api_keys_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.company_api_keys
    ADD CONSTRAINT company_api_keys_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.company_api_log
    ADD CONSTRAINT company_api_log_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.company_api_log
    ADD CONSTRAINT company_api_log_key_id_fkey FOREIGN KEY (key_id) REFERENCES public.company_api_keys(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.company_backup_storage
    ADD CONSTRAINT company_backup_storage_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.company_invites
    ADD CONSTRAINT company_invites_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.company_invites
    ADD CONSTRAINT company_invites_invited_by_id_users_id_fk FOREIGN KEY (invited_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.company_invites
    ADD CONSTRAINT company_invites_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.company_members
    ADD CONSTRAINT company_members_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.company_members
    ADD CONSTRAINT company_members_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.company_storage
    ADD CONSTRAINT company_storage_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.company_webhooks
    ADD CONSTRAINT company_webhooks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.credential_access_log
    ADD CONSTRAINT credential_access_log_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.credential_access_log
    ADD CONSTRAINT credential_access_log_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.credentials
    ADD CONSTRAINT credentials_created_by_id_users_id_fk FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.credentials
    ADD CONSTRAINT credentials_deleted_by_id_users_id_fk FOREIGN KEY (deleted_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.credentials
    ADD CONSTRAINT credentials_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.db_connections
    ADD CONSTRAINT db_connections_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.db_connections
    ADD CONSTRAINT db_connections_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.db_query_log
    ADD CONSTRAINT db_query_log_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.db_connections(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.db_query_log
    ADD CONSTRAINT db_query_log_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.db_query_log
    ADD CONSTRAINT db_query_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.db_table_policies
    ADD CONSTRAINT db_table_policies_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.db_connections(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_author_id_users_id_fk FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_document_id_documents_id_fk FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_created_by_id_users_id_fk FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_deleted_by_id_users_id_fk FOREIGN KEY (deleted_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_updated_by_id_users_id_fk FOREIGN KEY (updated_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.embedding_queue
    ADD CONSTRAINT embedding_queue_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.embeddings
    ADD CONSTRAINT embeddings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.embeddings
    ADD CONSTRAINT embeddings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.feedback
    ADD CONSTRAINT feedback_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_comment_id_task_comments_id_fk FOREIGN KEY (comment_id) REFERENCES public.task_comments(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_deleted_by_id_users_id_fk FOREIGN KEY (deleted_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_message_id_messages_id_fk FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_task_id_tasks_id_fk FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_uploaded_by_id_users_id_fk FOREIGN KEY (uploaded_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_author_id_users_id_fk FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_recipient_id_users_id_fk FOREIGN KEY (recipient_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.model_pricing
    ADD CONSTRAINT model_pricing_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_author_id_users_id_fk FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_deleted_by_id_users_id_fk FOREIGN KEY (deleted_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_task_id_tasks_id_fk FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.notification_log
    ADD CONSTRAINT notification_log_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.notification_log
    ADD CONSTRAINT notification_log_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.notification_opt_outs
    ADD CONSTRAINT notification_opt_outs_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.notification_opt_outs
    ADD CONSTRAINT notification_opt_outs_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_actor_id_users_id_fk FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.project_ai
    ADD CONSTRAINT project_ai_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.project_features
    ADD CONSTRAINT project_features_enabled_by_id_fk FOREIGN KEY (enabled_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.project_features
    ADD CONSTRAINT project_features_project_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.project_integrations
    ADD CONSTRAINT project_integrations_creator_fk FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.project_integrations
    ADD CONSTRAINT project_integrations_project_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.project_storage
    ADD CONSTRAINT project_storage_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_company_id_companies_id_fk FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.release_events
    ADD CONSTRAINT release_events_actor_id_fk FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.release_events
    ADD CONSTRAINT release_events_release_id_fk FOREIGN KEY (release_id) REFERENCES public.releases(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.releases
    ADD CONSTRAINT releases_owner_id_fk FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.releases
    ADD CONSTRAINT releases_project_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.resource_files
    ADD CONSTRAINT resource_files_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.credentials(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.resource_files
    ADD CONSTRAINT resource_files_uploaded_by_id_fkey FOREIGN KEY (uploaded_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.resource_secrets
    ADD CONSTRAINT resource_secrets_resource_id_credentials_id_fk FOREIGN KEY (resource_id) REFERENCES public.credentials(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.resource_viewers
    ADD CONSTRAINT resource_viewers_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.credentials(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.resource_viewers
    ADD CONSTRAINT resource_viewers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.sandbox_messages
    ADD CONSTRAINT sandbox_messages_message_id_messages_id_fk FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.shares
    ADD CONSTRAINT shares_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.shares
    ADD CONSTRAINT shares_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.short_links
    ADD CONSTRAINT short_links_created_by_id_users_id_fk FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.short_links
    ADD CONSTRAINT short_links_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.task_blockers
    ADD CONSTRAINT task_blockers_blocked_task_id_fkey FOREIGN KEY (blocked_task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.task_blockers
    ADD CONSTRAINT task_blockers_blocker_task_id_fkey FOREIGN KEY (blocker_task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.task_blockers
    ADD CONSTRAINT task_blockers_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.task_blockers
    ADD CONSTRAINT task_blockers_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.task_checklist
    ADD CONSTRAINT task_checklist_done_by_id_fkey FOREIGN KEY (done_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.task_checklist
    ADD CONSTRAINT task_checklist_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.task_checklist
    ADD CONSTRAINT task_checklist_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.task_comments
    ADD CONSTRAINT task_comments_author_id_users_id_fk FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.task_comments
    ADD CONSTRAINT task_comments_deleted_by_id_users_id_fk FOREIGN KEY (deleted_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.task_comments
    ADD CONSTRAINT task_comments_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.task_comments
    ADD CONSTRAINT task_comments_task_id_tasks_id_fk FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.task_groups
    ADD CONSTRAINT task_groups_created_by_id_users_id_fk FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.task_groups
    ADD CONSTRAINT task_groups_deleted_by_id_users_id_fk FOREIGN KEY (deleted_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.task_groups
    ADD CONSTRAINT task_groups_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.task_links
    ADD CONSTRAINT task_links_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.task_links
    ADD CONSTRAINT task_links_from_task_id_fkey FOREIGN KEY (from_task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.task_links
    ADD CONSTRAINT task_links_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.task_links
    ADD CONSTRAINT task_links_to_task_id_fkey FOREIGN KEY (to_task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.task_notes
    ADD CONSTRAINT task_notes_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.task_notes
    ADD CONSTRAINT task_notes_task_id_tasks_id_fk FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.task_releases
    ADD CONSTRAINT task_releases_release_id_fk FOREIGN KEY (release_id) REFERENCES public.releases(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.task_releases
    ADD CONSTRAINT task_releases_task_id_fk FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.task_reminders
    ADD CONSTRAINT task_reminders_created_by_id_users_id_fk FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.task_reminders
    ADD CONSTRAINT task_reminders_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.task_resources
    ADD CONSTRAINT task_resources_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.credentials(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.task_resources
    ADD CONSTRAINT task_resources_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_assignee_id_users_id_fk FOREIGN KEY (assignee_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_created_by_id_users_id_fk FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_deleted_by_id_users_id_fk FOREIGN KEY (deleted_by_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_group_id_task_groups_id_fk FOREIGN KEY (group_id) REFERENCES public.task_groups(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.time_entries
    ADD CONSTRAINT time_entries_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.time_entries
    ADD CONSTRAINT time_entries_task_id_tasks_id_fk FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE ONLY public.time_entries
    ADD CONSTRAINT time_entries_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.user_notification_prefs
    ADD CONSTRAINT user_notification_prefs_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_webhook_id_fkey FOREIGN KEY (webhook_id) REFERENCES public.company_webhooks(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.work_log
    ADD CONSTRAINT work_log_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.work_log
    ADD CONSTRAINT work_log_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ONLY public.work_log
    ADD CONSTRAINT work_log_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;
