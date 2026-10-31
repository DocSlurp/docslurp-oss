CREATE TABLE "credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"delta" numeric(12, 2) NOT NULL,
	"reason" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"is_personal" boolean DEFAULT false NOT NULL,
	"personal_owner_user_id" text,
	"created_by_user_id" text NOT NULL,
	"credit_balance_cents" integer DEFAULT 0 NOT NULL,
	"monthly_budget_cents" integer,
	"budget_alert_threshold_percent" integer DEFAULT 80 NOT NULL,
	"budget_alert_level" integer DEFAULT 0 NOT NULL,
	"budget_alert_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"budget_paused" boolean DEFAULT false NOT NULL,
	"sso_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "organizations_slug_key" UNIQUE("slug"),
	CONSTRAINT "organizations_personal_owner_user_id_key" UNIQUE("personal_owner_user_id"),
	CONSTRAINT "organizations_budget_alert_threshold_percent_check" CHECK ((budget_alert_threshold_percent >= 1) AND (budget_alert_threshold_percent <= 100))
);
--> statement-breakpoint
CREATE TABLE "vector_indexes" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"backend" text NOT NULL,
	"bucket" text NOT NULL,
	"path" text NOT NULL,
	"embedding_model" text NOT NULL,
	"dimension" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text,
	"document_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"metric" text NOT NULL,
	"amount" numeric(12, 4) NOT NULL,
	"unit" text NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"source_key" text NOT NULL,
	"status" text NOT NULL,
	"extraction_mode" text DEFAULT 'hybrid' NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" text,
	"version_number" integer DEFAULT 1 NOT NULL,
	"previous_version_id" text,
	"source_sha256" text,
	"deduped_from_document_id" text,
	"dedup_scope" text,
	"file_size" bigint DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "documents_dedup_scope_check" CHECK (dedup_scope = ANY (ARRAY['workspace'::text, 'org'::text]))
);
--> statement-breakpoint
CREATE TABLE "performance_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text,
	"document_id" text,
	"scope" text NOT NULL,
	"stage_name" text NOT NULL,
	"metric" text NOT NULL,
	"page_number" integer,
	"value" numeric(16, 4) NOT NULL,
	"unit" text NOT NULL,
	"tags" text[] DEFAULT '{""}' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text NOT NULL,
	"document_id" text,
	"stage_name" text,
	"event_type" text NOT NULL,
	"status" text,
	"message" text,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_secrets_workspace_id_name_key" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
CREATE TABLE "schema_migrations" (
	"name" text PRIMARY KEY NOT NULL,
	"checksum" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"execution_ms" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_key" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	CONSTRAINT "session_token_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"org_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"accepted_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_invites_token_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "document_corrections" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"run_id" text,
	"user_id" text NOT NULL,
	"corrected_markdown" text,
	"corrected_structured_data" jsonb,
	"notes" text,
	"reindex_requested_at" timestamp with time zone,
	"reindex_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_corrections_document_id_key" UNIQUE("document_id")
);
--> statement-breakpoint
CREATE TABLE "page_stage_states" (
	"id" text PRIMARY KEY DEFAULT (gen_random_uuid()) NOT NULL,
	"run_id" text NOT NULL,
	"document_id" text NOT NULL,
	"stage_name" text NOT NULL,
	"page_number" integer NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_connectors" (
	"id" text PRIMARY KEY DEFAULT (gen_random_uuid()) NOT NULL,
	"workspace_id" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"credentials_encrypted" text DEFAULT '' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" text[] DEFAULT '{"run.completed","run.failed"}' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"heading_path" text[] DEFAULT '{""}' NOT NULL,
	"page_number" integer,
	"token_estimate" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text,
	"pipeline_version" text,
	"parent_page_id" text,
	"ts_content" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, text)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"user_id" text NOT NULL,
	"event_type" text NOT NULL,
	"target_url" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_status" integer,
	"response_body" text,
	"delivered" boolean DEFAULT false NOT NULL,
	"error" text,
	"replay_of_delivery_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"workspace_id" text,
	"run_completed" boolean DEFAULT true NOT NULL,
	"run_failed" boolean DEFAULT true NOT NULL,
	"quality_warning" boolean DEFAULT true NOT NULL,
	"cost_alert" boolean DEFAULT true NOT NULL,
	"workspace_invite" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"page_number" integer NOT NULL,
	"text" text NOT NULL,
	"token_estimate" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text,
	"workspace_id" text,
	"event_type" text NOT NULL,
	"provider" text NOT NULL,
	"recipient" text NOT NULL,
	"subject" text NOT NULL,
	"delivered" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"name" text NOT NULL,
	"key_type" text DEFAULT 'server' NOT NULL,
	"allowed_domains" text[] DEFAULT '{}' NOT NULL,
	"scopes" text[] DEFAULT '{"ingest","search","artifacts"}' NOT NULL,
	"rate_limit_rpm" integer DEFAULT 60 NOT NULL,
	"rate_limit_ppd" integer DEFAULT 10000 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"org_id" text,
	CONSTRAINT "api_keys_key_hash_key" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "document_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"query" text NOT NULL,
	"variant" text,
	"result_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_session_results" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"chunk_id" text NOT NULL,
	"rank" integer NOT NULL,
	"score" numeric(8, 6) DEFAULT '0' NOT NULL,
	"clicked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"user_id" text,
	"workspace_id" text,
	"run_id" text,
	"document_id" text,
	"api_key_id" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"ip_address" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_eval_fixtures" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text,
	"question" text NOT NULL,
	"expected_chunk_ids" text[] DEFAULT '{""}' NOT NULL,
	"tags" text[] DEFAULT '{""}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_index_staleness" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text NOT NULL,
	"document_id" text NOT NULL,
	"reason" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reindex_queued_at" timestamp with time zone,
	"reindex_completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "document_propositions" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"source_paragraph" text NOT NULL,
	"token_estimate" integer DEFAULT 0 NOT NULL,
	"ts_content" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, text)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_cache" (
	"id" text PRIMARY KEY DEFAULT (gen_random_uuid()) NOT NULL,
	"idempotency_key" text NOT NULL,
	"route_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"user_id" text,
	"response_status" integer NOT NULL,
	"response_body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_cache_idempotency_key_route_key_key" UNIQUE("idempotency_key","route_key")
);
--> statement-breakpoint
CREATE TABLE "search_experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"control_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"treatment_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"traffic_percent" integer DEFAULT 50 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "search_experiments_name_key" UNIQUE("name"),
	CONSTRAINT "search_experiments_traffic_percent_check" CHECK ((traffic_percent >= 0) AND (traffic_percent <= 100))
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"workspace_id" text,
	"api_key_id" text,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"latency_class" text DEFAULT 'standard' NOT NULL,
	"output_format" text DEFAULT 'answer' NOT NULL,
	"goal" text NOT NULL,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"estimated_cost_cents" integer DEFAULT 0 NOT NULL,
	"max_cost_cents" integer,
	"error_code" text,
	"error_message" text,
	"error_retryable" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" text,
	"template_key" text,
	"monthly_budget_cents" integer,
	"budget_alert_threshold_percent" integer DEFAULT 80 NOT NULL,
	"budget_alert_level" integer DEFAULT 0 NOT NULL,
	"budget_alert_updated_at" timestamp with time zone,
	"artifact_retention_days" integer,
	"run_retention_days" integer,
	"pipeline" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"system_prompt" text,
	"budget_paused" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "workspaces_system_prompt_length_check" CHECK ((system_prompt IS NULL) OR (char_length(system_prompt) <= 2000))
);
--> statement-breakpoint
CREATE TABLE "ai_operation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_operation_events_operation_id_sequence_key" UNIQUE("operation_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "grounded_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"document_id" text,
	"run_id" text,
	"workspace_id" text,
	"scope" text DEFAULT 'workspace' NOT NULL,
	"section_key" text,
	"summary" text NOT NULL,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_spans" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pii_detections" (
	"id" text PRIMARY KEY DEFAULT (gen_random_uuid()) NOT NULL,
	"document_id" text NOT NULL,
	"run_id" text NOT NULL,
	"pattern_type" text NOT NULL,
	"matched_prefix" text NOT NULL,
	"page_number" integer,
	"byte_offset" integer,
	"redacted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_answer_evidence_spans" (
	"id" text PRIMARY KEY NOT NULL,
	"answer_id" text NOT NULL,
	"session_id" text NOT NULL,
	"search_session_id" text,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"citation_index" integer NOT NULL,
	"answer_start" integer NOT NULL,
	"answer_end" integer NOT NULL,
	"answer_text" text NOT NULL,
	"source_text" text NOT NULL,
	"source_start" integer NOT NULL,
	"source_end" integer NOT NULL,
	"citation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parser_eval_fixtures" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text,
	"document_id" text NOT NULL,
	"name" text NOT NULL,
	"parser" text NOT NULL,
	"min_match_ratio" numeric(8, 6) DEFAULT '0' NOT NULL,
	"min_bbox_ratio" numeric(8, 6) DEFAULT '0' NOT NULL,
	"min_page_ratio" numeric(8, 6) DEFAULT '0' NOT NULL,
	"require_selected" boolean DEFAULT true NOT NULL,
	"tags" text[] DEFAULT '{""}' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parser_eval_results" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"run_id" text NOT NULL,
	"document_id" text NOT NULL,
	"stage_name" text NOT NULL,
	"parser" text NOT NULL,
	"matched_blocks" integer DEFAULT 0 NOT NULL,
	"bbox_blocks" integer DEFAULT 0 NOT NULL,
	"page_backed_blocks" integer DEFAULT 0 NOT NULL,
	"match_ratio" numeric(8, 6) DEFAULT '0' NOT NULL,
	"bbox_ratio" numeric(8, 6) DEFAULT '0' NOT NULL,
	"page_ratio" numeric(8, 6) DEFAULT '0' NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"artifact_uri" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text,
	"workspace_id" text,
	"workspace_name" text,
	"template_key" text,
	"pipeline" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_session_files" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"source_key" text NOT NULL,
	"upload_mode" text NOT NULL,
	"upload_id" text,
	"part_size" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"etag" text,
	"completed_parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"stage" text NOT NULL,
	"total_documents" integer DEFAULT 0 NOT NULL,
	"processed_documents" integer DEFAULT 0 NOT NULL,
	"pages_total" integer DEFAULT 0 NOT NULL,
	"pages_processed" integer DEFAULT 0 NOT NULL,
	"input_cost_cents" integer DEFAULT 0 NOT NULL,
	"output_cost_cents" integer DEFAULT 0 NOT NULL,
	"pipeline" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"artifacts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_id" text,
	"lease_expires_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"control_state" text,
	"control_requested_at" timestamp with time zone,
	"artifacts_purged_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"dead_lettered_at" timestamp with time zone,
	"dead_letter_reason" text
);
--> statement-breakpoint
CREATE TABLE "search_zero_results" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"reason" text NOT NULL,
	"suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_search_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"typo_tolerance" boolean DEFAULT true NOT NULL,
	"dedupe_by_filename" boolean DEFAULT true NOT NULL,
	"ranking_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"boosts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pinned_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synonyms" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"compat_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compat_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "query_suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"phrase" text NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_audit_log" (
	"id" text PRIMARY KEY DEFAULT (gen_random_uuid()) NOT NULL,
	"document_id" text,
	"run_id" text,
	"workspace_id" text,
	"model_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"privacy_mode" text DEFAULT 'standard' NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_sync_log" (
	"id" text PRIMARY KEY DEFAULT (gen_random_uuid()) NOT NULL,
	"connector_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"files_added" integer DEFAULT 0 NOT NULL,
	"files_updated" integer DEFAULT 0 NOT NULL,
	"files_deleted" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"cost_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_accounts" (
	"id" text PRIMARY KEY DEFAULT (gen_random_uuid()) NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"access_token_encrypted" "bytea",
	"refresh_token_encrypted" "bytea",
	"token_expires_at" timestamp with time zone,
	"raw_profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_accounts_provider_provider_account_id_key" UNIQUE("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "sso_auth_requests" (
	"id" text PRIMARY KEY DEFAULT (gen_random_uuid()) NOT NULL,
	"state" text NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"code_verifier" text,
	"nonce" text,
	"redirect_path" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_auth_requests_state_key" UNIQUE("state"),
	CONSTRAINT "sso_auth_requests_provider_check" CHECK (provider = ANY (ARRAY['oidc'::text, 'saml'::text]))
);
--> statement-breakpoint
CREATE TABLE "stripe_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_topups" (
	"payment_intent_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_topups_amount_cents_check" CHECK (amount_cents > 0)
);
--> statement-breakpoint
CREATE TABLE "kg_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"canonical_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"entity_type" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mention_count" integer DEFAULT 0 NOT NULL,
	"source_document_count" integer DEFAULT 0 NOT NULL,
	"confidence" numeric(5, 4) DEFAULT '0.5' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kg_nodes_workspace_id_normalized_name_entity_type_key" UNIQUE("workspace_id","normalized_name","entity_type")
);
--> statement-breakpoint
CREATE TABLE "kg_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source_node_id" text NOT NULL,
	"target_node_id" text NOT NULL,
	"predicate" text NOT NULL,
	"normalized_predicate" text NOT NULL,
	"confidence" numeric(5, 4) DEFAULT '0.5' NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kg_edges_workspace_id_source_node_id_target_node_id_normali_key" UNIQUE("workspace_id","source_node_id","target_node_id","normalized_predicate")
);
--> statement-breakpoint
CREATE TABLE "kg_communities" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"label" text NOT NULL,
	"summary" text NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_memberships" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_memberships_pkey" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "document_tags" (
	"document_id" text NOT NULL,
	"user_id" text NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_tags_pkey" PRIMARY KEY("document_id","tag")
);
--> statement-breakpoint
CREATE TABLE "api_key_usage" (
	"key_id" text NOT NULL,
	"minute_bucket" timestamp with time zone NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "api_key_usage_pkey" PRIMARY KEY("key_id","minute_bucket")
);
--> statement-breakpoint
CREATE TABLE "kg_community_members" (
	"community_id" text NOT NULL,
	"node_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kg_community_members_pkey" PRIMARY KEY("community_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"invited_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_pkey" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_run_stage_states" (
	"run_id" text NOT NULL,
	"stage_name" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"artifact_uri" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_run_stage_states_pkey" PRIMARY KEY("run_id","stage_name")
);
--> statement-breakpoint
CREATE TABLE "document_run_stage_states" (
	"run_id" text NOT NULL,
	"document_id" text NOT NULL,
	"stage_name" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"artifact_uri" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_run_stage_states_pkey" PRIMARY KEY("run_id","document_id","stage_name")
);
--> statement-breakpoint
CREATE TABLE "chunk_entities" (
	"chunk_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"node_id" text NOT NULL,
	"entity_name" text NOT NULL,
	"entity_type" text NOT NULL,
	"mention_count" integer DEFAULT 1 NOT NULL,
	"confidence" numeric(5, 4) DEFAULT '0.5' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunk_entities_pkey" PRIMARY KEY("chunk_id","node_id")
);
--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_personal_owner_user_id_fkey" FOREIGN KEY ("personal_owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vector_indexes" ADD CONSTRAINT "vector_indexes_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_deduped_from_document_id_fkey" FOREIGN KEY ("deduped_from_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "performance_log" ADD CONSTRAINT "performance_log_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "performance_log" ADD CONSTRAINT "performance_log_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "performance_log" ADD CONSTRAINT "performance_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_run_events" ADD CONSTRAINT "workspace_run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_run_events" ADD CONSTRAINT "workspace_run_events_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_run_events" ADD CONSTRAINT "workspace_run_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_secrets" ADD CONSTRAINT "workspace_secrets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_corrections" ADD CONSTRAINT "document_corrections_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_corrections" ADD CONSTRAINT "document_corrections_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_corrections" ADD CONSTRAINT "document_corrections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "page_stage_states" ADD CONSTRAINT "page_stage_states_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "page_stage_states" ADD CONSTRAINT "page_stage_states_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_connectors" ADD CONSTRAINT "workspace_connectors_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_parent_page_id_fkey" FOREIGN KEY ("parent_page_id") REFERENCES "public"."document_pages"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_replay_of_delivery_id_fkey" FOREIGN KEY ("replay_of_delivery_id") REFERENCES "public"."webhook_deliveries"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_pages" ADD CONSTRAINT "document_pages_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_pages" ADD CONSTRAINT "document_pages_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_pages" ADD CONSTRAINT "document_pages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_summaries" ADD CONSTRAINT "document_summaries_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_summaries" ADD CONSTRAINT "document_summaries_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_summaries" ADD CONSTRAINT "document_summaries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "search_sessions" ADD CONSTRAINT "search_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "search_session_results" ADD CONSTRAINT "search_session_results_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."search_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "search_eval_fixtures" ADD CONSTRAINT "search_eval_fixtures_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "search_eval_fixtures" ADD CONSTRAINT "search_eval_fixtures_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "search_index_staleness" ADD CONSTRAINT "search_index_staleness_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "search_index_staleness" ADD CONSTRAINT "search_index_staleness_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "search_index_staleness" ADD CONSTRAINT "search_index_staleness_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_propositions" ADD CONSTRAINT "document_propositions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_propositions" ADD CONSTRAINT "document_propositions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_propositions" ADD CONSTRAINT "document_propositions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "idempotency_cache" ADD CONSTRAINT "idempotency_cache_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "search_experiments" ADD CONSTRAINT "search_experiments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_operations" ADD CONSTRAINT "ai_operations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_operations" ADD CONSTRAINT "ai_operations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_operations" ADD CONSTRAINT "ai_operations_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_operations" ADD CONSTRAINT "ai_operations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_operation_events" ADD CONSTRAINT "ai_operation_events_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "public"."ai_operations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "grounded_summaries" ADD CONSTRAINT "grounded_summaries_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "grounded_summaries" ADD CONSTRAINT "grounded_summaries_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "grounded_summaries" ADD CONSTRAINT "grounded_summaries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "grounded_summaries" ADD CONSTRAINT "grounded_summaries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pii_detections" ADD CONSTRAINT "pii_detections_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pii_detections" ADD CONSTRAINT "pii_detections_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_answer_evidence_spans" ADD CONSTRAINT "chat_answer_evidence_spans_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_answer_evidence_spans" ADD CONSTRAINT "chat_answer_evidence_spans_search_session_id_fkey" FOREIGN KEY ("search_session_id") REFERENCES "public"."search_sessions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_answer_evidence_spans" ADD CONSTRAINT "chat_answer_evidence_spans_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_answer_evidence_spans" ADD CONSTRAINT "chat_answer_evidence_spans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "parser_eval_fixtures" ADD CONSTRAINT "parser_eval_fixtures_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "parser_eval_fixtures" ADD CONSTRAINT "parser_eval_fixtures_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "parser_eval_fixtures" ADD CONSTRAINT "parser_eval_fixtures_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "parser_eval_results" ADD CONSTRAINT "parser_eval_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "parser_eval_results" ADD CONSTRAINT "parser_eval_results_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "parser_eval_results" ADD CONSTRAINT "parser_eval_results_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "upload_session_files" ADD CONSTRAINT "upload_session_files_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."upload_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_runs" ADD CONSTRAINT "workspace_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_runs" ADD CONSTRAINT "workspace_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "search_zero_results" ADD CONSTRAINT "search_zero_results_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."search_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "search_zero_results" ADD CONSTRAINT "search_zero_results_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "search_zero_results" ADD CONSTRAINT "search_zero_results_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_search_settings" ADD CONSTRAINT "workspace_search_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_search_settings" ADD CONSTRAINT "workspace_search_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "query_suggestions" ADD CONSTRAINT "query_suggestions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "query_suggestions" ADD CONSTRAINT "query_suggestions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "privacy_audit_log" ADD CONSTRAINT "privacy_audit_log_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "privacy_audit_log" ADD CONSTRAINT "privacy_audit_log_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "privacy_audit_log" ADD CONSTRAINT "privacy_audit_log_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "connector_sync_log" ADD CONSTRAINT "connector_sync_log_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "public"."workspace_connectors"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sso_auth_requests" ADD CONSTRAINT "sso_auth_requests_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stripe_topups" ADD CONSTRAINT "stripe_topups_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_nodes" ADD CONSTRAINT "kg_nodes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_nodes" ADD CONSTRAINT "kg_nodes_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_nodes" ADD CONSTRAINT "kg_nodes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_edges" ADD CONSTRAINT "kg_edges_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_edges" ADD CONSTRAINT "kg_edges_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_edges" ADD CONSTRAINT "kg_edges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_edges" ADD CONSTRAINT "kg_edges_source_node_id_fkey" FOREIGN KEY ("source_node_id") REFERENCES "public"."kg_nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_edges" ADD CONSTRAINT "kg_edges_target_node_id_fkey" FOREIGN KEY ("target_node_id") REFERENCES "public"."kg_nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_communities" ADD CONSTRAINT "kg_communities_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_communities" ADD CONSTRAINT "kg_communities_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_communities" ADD CONSTRAINT "kg_communities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_key_usage" ADD CONSTRAINT "api_key_usage_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_community_members" ADD CONSTRAINT "kg_community_members_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "public"."kg_communities"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_community_members" ADD CONSTRAINT "kg_community_members_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "public"."kg_nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_community_members" ADD CONSTRAINT "kg_community_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_run_stage_states" ADD CONSTRAINT "workspace_run_stage_states_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_run_stage_states" ADD CONSTRAINT "document_run_stage_states_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_run_stage_states" ADD CONSTRAINT "document_run_stage_states_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chunk_entities" ADD CONSTRAINT "chunk_entities_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "public"."document_chunks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chunk_entities" ADD CONSTRAINT "chunk_entities_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chunk_entities" ADD CONSTRAINT "chunk_entities_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chunk_entities" ADD CONSTRAINT "chunk_entities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chunk_entities" ADD CONSTRAINT "chunk_entities_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "public"."kg_nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_stripe_customer_id_idx" ON "organizations" USING btree ("stripe_customer_id") WHERE (stripe_customer_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX "vector_indexes_document_id_idx" ON "vector_indexes" USING btree ("document_id");
--> statement-breakpoint
CREATE INDEX "usage_events_run_id_idx" ON "usage_events" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "documents_org_id_idx" ON "documents" USING btree ("org_id","created_at");
--> statement-breakpoint
CREATE INDEX "documents_org_source_sha256_idx" ON "documents" USING btree ("org_id","source_sha256") WHERE (source_sha256 IS NOT NULL);
--> statement-breakpoint
CREATE INDEX "documents_run_id_idx" ON "documents" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "documents_workspace_id_idx" ON "documents" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "documents_workspace_source_sha256_idx" ON "documents" USING btree ("workspace_id","source_sha256") WHERE (source_sha256 IS NOT NULL);
--> statement-breakpoint
CREATE INDEX "performance_log_document_id_idx" ON "performance_log" USING btree ("document_id","created_at");
--> statement-breakpoint
CREATE INDEX "performance_log_run_id_idx" ON "performance_log" USING btree ("run_id","created_at");
--> statement-breakpoint
CREATE INDEX "performance_log_stage_name_idx" ON "performance_log" USING btree ("stage_name","created_at");
--> statement-breakpoint
CREATE INDEX "workspace_run_events_run_id_idx" ON "workspace_run_events" USING btree ("run_id","created_at");
--> statement-breakpoint
CREATE INDEX "workspace_run_events_user_id_idx" ON "workspace_run_events" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "workspace_secrets_expires_at_idx" ON "workspace_secrets" USING btree ("expires_at") WHERE (expires_at IS NOT NULL);
--> statement-breakpoint
CREATE INDEX "workspace_secrets_workspace_id_idx" ON "workspace_secrets" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("userId");
--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");
--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_idx" ON "account" USING btree ("providerId","accountId");
--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("userId");
--> statement-breakpoint
CREATE INDEX "workspace_invites_email_idx" ON "workspace_invites" USING btree ("email","status","created_at");
--> statement-breakpoint
CREATE INDEX "workspace_invites_workspace_id_idx" ON "workspace_invites" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "document_corrections_run_id_idx" ON "document_corrections" USING btree ("run_id","updated_at");
--> statement-breakpoint
CREATE INDEX "document_corrections_user_id_idx" ON "document_corrections" USING btree ("user_id","updated_at");
--> statement-breakpoint
CREATE INDEX "page_stage_states_run_doc_stage_idx" ON "page_stage_states" USING btree ("run_id","document_id","stage_name");
--> statement-breakpoint
CREATE UNIQUE INDEX "page_stage_states_unique_idx" ON "page_stage_states" USING btree ("run_id","document_id","stage_name","page_number");
--> statement-breakpoint
CREATE INDEX "idx_workspace_connectors_status" ON "workspace_connectors" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "idx_workspace_connectors_workspace_id" ON "workspace_connectors" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX "webhooks_user_id_idx" ON "webhooks" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "document_chunks_ts_content_idx" ON "document_chunks" USING gin ("ts_content" tsvector_ops);
--> statement-breakpoint
CREATE INDEX "document_chunks_ts_content_idx1" ON "document_chunks" USING gin ("ts_content" tsvector_ops);
--> statement-breakpoint
CREATE INDEX "document_chunks_user_id_run_id_idx" ON "document_chunks" USING btree ("user_id","run_id");
--> statement-breakpoint
CREATE INDEX "document_chunks_user_id_run_id_idx1" ON "document_chunks" USING btree ("user_id","run_id");
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_user_id_idx" ON "webhook_deliveries" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_id_idx" ON "webhook_deliveries" USING btree ("webhook_id","created_at");
--> statement-breakpoint
CREATE INDEX "document_pages_document_id_page_number_idx" ON "document_pages" USING btree ("document_id","page_number");
--> statement-breakpoint
CREATE INDEX "document_pages_document_id_page_number_idx1" ON "document_pages" USING btree ("document_id","page_number");
--> statement-breakpoint
CREATE INDEX "document_pages_run_id_idx" ON "document_pages" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "document_pages_run_id_idx1" ON "document_pages" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "notification_deliveries_user_id_idx" ON "notification_deliveries" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "notification_deliveries_user_read_idx" ON "notification_deliveries" USING btree ("user_id","read_at","created_at");
--> statement-breakpoint
CREATE INDEX "notification_deliveries_workspace_id_idx" ON "notification_deliveries" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "api_keys_org_id_idx" ON "api_keys" USING btree ("org_id","created_at");
--> statement-breakpoint
CREATE INDEX "document_summaries_user_id_run_id_idx" ON "document_summaries" USING btree ("user_id","run_id");
--> statement-breakpoint
CREATE INDEX "document_summaries_user_id_run_id_idx1" ON "document_summaries" USING btree ("user_id","run_id");
--> statement-breakpoint
CREATE INDEX "search_sessions_user_id_created_at_idx" ON "search_sessions" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "search_sessions_user_id_created_at_idx1" ON "search_sessions" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "search_session_results_chunk_id_idx" ON "search_session_results" USING btree ("chunk_id");
--> statement-breakpoint
CREATE INDEX "search_session_results_chunk_id_idx1" ON "search_session_results" USING btree ("chunk_id");
--> statement-breakpoint
CREATE INDEX "search_session_results_session_id_idx" ON "search_session_results" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX "search_session_results_session_id_idx1" ON "search_session_results" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action","created_at");
--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at","id");
--> statement-breakpoint
CREATE INDEX "audit_log_org_id_idx" ON "audit_log" USING btree ("org_id","created_at");
--> statement-breakpoint
CREATE INDEX "audit_log_resource_idx" ON "audit_log" USING btree ("resource_type","resource_id","created_at");
--> statement-breakpoint
CREATE INDEX "audit_log_run_id_idx" ON "audit_log" USING btree ("run_id","created_at");
--> statement-breakpoint
CREATE INDEX "audit_log_user_id_idx" ON "audit_log" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "audit_log_workspace_id_idx" ON "audit_log" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "search_eval_fixtures_user_id_idx" ON "search_eval_fixtures" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "search_eval_fixtures_user_id_idx1" ON "search_eval_fixtures" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "search_index_staleness_run_id_idx" ON "search_index_staleness" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "search_index_staleness_run_id_idx1" ON "search_index_staleness" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "search_index_staleness_user_id_detected_at_idx" ON "search_index_staleness" USING btree ("user_id","detected_at");
--> statement-breakpoint
CREATE INDEX "search_index_staleness_user_id_detected_at_idx1" ON "search_index_staleness" USING btree ("user_id","detected_at");
--> statement-breakpoint
CREATE INDEX "document_propositions_document_id_idx" ON "document_propositions" USING btree ("document_id");
--> statement-breakpoint
CREATE INDEX "document_propositions_document_id_idx1" ON "document_propositions" USING btree ("document_id");
--> statement-breakpoint
CREATE INDEX "document_propositions_ts_content_idx" ON "document_propositions" USING gin ("ts_content" tsvector_ops);
--> statement-breakpoint
CREATE INDEX "document_propositions_ts_content_idx1" ON "document_propositions" USING gin ("ts_content" tsvector_ops);
--> statement-breakpoint
CREATE INDEX "document_propositions_user_id_run_id_idx" ON "document_propositions" USING btree ("user_id","run_id");
--> statement-breakpoint
CREATE INDEX "document_propositions_user_id_run_id_idx1" ON "document_propositions" USING btree ("user_id","run_id");
--> statement-breakpoint
CREATE INDEX "idempotency_cache_expires_at_idx" ON "idempotency_cache" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "search_experiments_user_id_active_idx" ON "search_experiments" USING btree ("user_id","active");
--> statement-breakpoint
CREATE INDEX "search_experiments_user_id_active_idx1" ON "search_experiments" USING btree ("user_id","active");
--> statement-breakpoint
CREATE INDEX "chat_sessions_user_id_idx" ON "chat_sessions" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "chat_sessions_workspace_id_idx" ON "chat_sessions" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "chat_turns_session_id_idx" ON "chat_turns" USING btree ("session_id","created_at");
--> statement-breakpoint
CREATE INDEX "ai_operations_api_key_id_idx" ON "ai_operations" USING btree ("api_key_id","created_at");
--> statement-breakpoint
CREATE INDEX "ai_operations_org_id_idx" ON "ai_operations" USING btree ("org_id","created_at");
--> statement-breakpoint
CREATE INDEX "ai_operations_status_idx" ON "ai_operations" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX "ai_operations_user_id_idx" ON "ai_operations" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "ai_operations_workspace_id_idx" ON "ai_operations" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "workspaces_archived_at_idx" ON "workspaces" USING btree ("archived_at","updated_at");
--> statement-breakpoint
CREATE INDEX "workspaces_org_id_idx" ON "workspaces" USING btree ("org_id","updated_at");
--> statement-breakpoint
CREATE INDEX "workspaces_user_id_idx" ON "workspaces" USING btree ("user_id","updated_at");
--> statement-breakpoint
CREATE INDEX "ai_operation_events_created_at_idx" ON "ai_operation_events" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "ai_operation_events_operation_id_idx" ON "ai_operation_events" USING btree ("operation_id","sequence");
--> statement-breakpoint
CREATE INDEX "grounded_summaries_document_id_idx" ON "grounded_summaries" USING btree ("document_id","created_at");
--> statement-breakpoint
CREATE INDEX "grounded_summaries_run_id_idx" ON "grounded_summaries" USING btree ("run_id","created_at");
--> statement-breakpoint
CREATE INDEX "grounded_summaries_workspace_id_idx" ON "grounded_summaries" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_pii_detections_document_id" ON "pii_detections" USING btree ("document_id");
--> statement-breakpoint
CREATE INDEX "idx_pii_detections_run_id" ON "pii_detections" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "chat_answer_evidence_spans_answer_id_idx" ON "chat_answer_evidence_spans" USING btree ("answer_id","citation_index");
--> statement-breakpoint
CREATE INDEX "chat_answer_evidence_spans_session_id_idx" ON "chat_answer_evidence_spans" USING btree ("session_id","created_at");
--> statement-breakpoint
CREATE INDEX "parser_eval_fixtures_document_id_idx" ON "parser_eval_fixtures" USING btree ("document_id","created_at");
--> statement-breakpoint
CREATE INDEX "parser_eval_fixtures_parser_idx" ON "parser_eval_fixtures" USING btree ("parser","created_at");
--> statement-breakpoint
CREATE INDEX "parser_eval_fixtures_run_id_idx" ON "parser_eval_fixtures" USING btree ("run_id","created_at");
--> statement-breakpoint
CREATE INDEX "parser_eval_fixtures_user_id_idx" ON "parser_eval_fixtures" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "parser_eval_results_document_id_idx" ON "parser_eval_results" USING btree ("document_id","created_at");
--> statement-breakpoint
CREATE INDEX "parser_eval_results_parser_idx" ON "parser_eval_results" USING btree ("parser","created_at");
--> statement-breakpoint
CREATE INDEX "parser_eval_results_run_id_idx" ON "parser_eval_results" USING btree ("run_id","created_at");
--> statement-breakpoint
CREATE INDEX "parser_eval_results_user_id_idx" ON "parser_eval_results" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "upload_sessions_user_id_idx" ON "upload_sessions" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "upload_sessions_workspace_id_idx" ON "upload_sessions" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "upload_session_files_session_id_idx" ON "upload_session_files" USING btree ("session_id","created_at");
--> statement-breakpoint
CREATE INDEX "upload_session_files_source_key_idx" ON "upload_session_files" USING btree ("source_key");
--> statement-breakpoint
CREATE INDEX "workspace_runs_dead_letter_idx" ON "workspace_runs" USING btree ("control_state","dead_lettered_at");
--> statement-breakpoint
CREATE INDEX "workspace_runs_lease_idx" ON "workspace_runs" USING btree ("status","lease_expires_at");
--> statement-breakpoint
CREATE INDEX "workspace_runs_org_id_idx" ON "workspace_runs" USING btree ("org_id","created_at");
--> statement-breakpoint
CREATE INDEX "workspace_runs_priority_idx" ON "workspace_runs" USING btree ("status","priority","created_at");
--> statement-breakpoint
CREATE INDEX "workspace_runs_status_idx" ON "workspace_runs" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX "workspace_runs_workspace_id_idx" ON "workspace_runs" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "search_zero_results_user_idx" ON "search_zero_results" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "search_zero_results_workspace_idx" ON "search_zero_results" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "workspace_search_settings_updated_idx" ON "workspace_search_settings" USING btree ("updated_at");
--> statement-breakpoint
CREATE INDEX "query_suggestions_ws_idx" ON "query_suggestions" USING btree ("workspace_id","weight","created_at");
--> statement-breakpoint
CREATE INDEX "idx_privacy_audit_log_document_id" ON "privacy_audit_log" USING btree ("document_id");
--> statement-breakpoint
CREATE INDEX "idx_privacy_audit_log_workspace_id" ON "privacy_audit_log" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX "idx_connector_sync_log_connector_id" ON "connector_sync_log" USING btree ("connector_id");
--> statement-breakpoint
CREATE INDEX "idx_connector_sync_log_started_at" ON "connector_sync_log" USING btree ("started_at");
--> statement-breakpoint
CREATE INDEX "oauth_accounts_user_id_idx" ON "oauth_accounts" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "sso_auth_requests_expires_idx" ON "sso_auth_requests" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "sso_auth_requests_org_idx" ON "sso_auth_requests" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "sso_auth_requests_provider_idx" ON "sso_auth_requests" USING btree ("provider");
--> statement-breakpoint
CREATE INDEX "stripe_webhook_events_event_type_idx" ON "stripe_webhook_events" USING btree ("event_type");
--> statement-breakpoint
CREATE INDEX "stripe_topups_org_id_idx" ON "stripe_topups" USING btree ("org_id","created_at");
--> statement-breakpoint
CREATE INDEX "kg_nodes_lookup_idx" ON "kg_nodes" USING btree ("workspace_id","entity_type","normalized_name");
--> statement-breakpoint
CREATE INDEX "kg_nodes_rank_idx" ON "kg_nodes" USING btree ("workspace_id","mention_count","source_document_count");
--> statement-breakpoint
CREATE INDEX "kg_edges_predicate_idx" ON "kg_edges" USING btree ("workspace_id","normalized_predicate","weight");
--> statement-breakpoint
CREATE INDEX "kg_edges_source_idx" ON "kg_edges" USING btree ("workspace_id","source_node_id");
--> statement-breakpoint
CREATE INDEX "kg_edges_target_idx" ON "kg_edges" USING btree ("workspace_id","target_node_id");
--> statement-breakpoint
CREATE INDEX "kg_communities_rank_idx" ON "kg_communities" USING btree ("workspace_id","level","member_count");
--> statement-breakpoint
CREATE INDEX "org_memberships_user_id_idx" ON "org_memberships" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "document_tags_document_id_idx" ON "document_tags" USING btree ("document_id");
--> statement-breakpoint
CREATE INDEX "document_tags_user_id_idx" ON "document_tags" USING btree ("user_id","tag");
--> statement-breakpoint
CREATE INDEX "kg_community_members_node_idx" ON "kg_community_members" USING btree ("workspace_id","node_id");
--> statement-breakpoint
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "workspace_run_stage_states_run_id_idx" ON "workspace_run_stage_states" USING btree ("run_id","updated_at");
--> statement-breakpoint
CREATE INDEX "document_run_stage_states_run_id_idx" ON "document_run_stage_states" USING btree ("run_id","document_id","updated_at");
--> statement-breakpoint
CREATE INDEX "chunk_entities_lookup_idx" ON "chunk_entities" USING btree ("workspace_id","entity_name","entity_type");
--> statement-breakpoint
CREATE INDEX "chunk_entities_node_idx" ON "chunk_entities" USING btree ("workspace_id","node_id");
--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."admin_stats" AS (SELECT date_trunc('hour'::text, created_at) AS hour, count(*) AS runs_count, sum(pages_total) AS pages_total, avg(output_cost_cents + input_cost_cents) AS avg_cost_cents FROM workspace_runs GROUP BY (date_trunc('hour'::text, created_at)));
--> statement-breakpoint
CREATE VIEW "public"."search_experiment_results" AS (SELECT e.id AS experiment_id, e.name, s.variant, count(DISTINCT s.id) AS query_count, avg(s.result_count) AS avg_result_count, sum( CASE WHEN sr.clicked THEN 1 ELSE 0 END)::double precision / NULLIF(count(sr.id)::double precision, 0::double precision) AS ctr FROM search_experiments e JOIN search_sessions s ON s.variant = e.id OR s.variant = e.name LEFT JOIN search_session_results sr ON sr.session_id = s.id GROUP BY e.id, e.name, s.variant);
