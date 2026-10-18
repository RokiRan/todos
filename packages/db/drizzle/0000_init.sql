CREATE TYPE "public"."doc_kind" AS ENUM('plan', 'changes', 'question', 'confirm', 'input', 'review');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."member_type" AS ENUM('user', 'agent');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('queued', 'pending', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."todo_phase" AS ENUM('todo', 'queued', 'planning', 'confirm', 'implement', 'review', 'reviewing', 'done', 'failed', 'closed');--> statement-breakpoint
CREATE TABLE "agent_connection_grant" (
	"agent_id" text NOT NULL,
	"connection_id" text NOT NULL,
	CONSTRAINT "agent_connection_grant_agent_id_connection_id_pk" PRIMARY KEY("agent_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "agent_memory" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"scope" text NOT NULL,
	"project_id" text,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"expires_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_skill" (
	"agent_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	CONSTRAINT "agent_skill_agent_id_skill_id_pk" PRIMARY KEY("agent_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "agent" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"provider" text,
	"model_id" text,
	"thinking_level" text,
	"default_skill_ids" text[] DEFAULT '{}' NOT NULL,
	"grants" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active_task_count" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"revoked_at" bigint,
	"last_used_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"team_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"todo_id" text,
	"build_id" text,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "build_message" (
	"id" text PRIMARY KEY NOT NULL,
	"build_id" text NOT NULL,
	"role" text NOT NULL,
	"phase" text,
	"trigger_by" text,
	"content" text NOT NULL,
	"agent" jsonb,
	"is_error" boolean DEFAULT false NOT NULL,
	"duration_ms" integer,
	"seq" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "build" (
	"id" text PRIMARY KEY NOT NULL,
	"todo_id" text NOT NULL,
	"n" integer NOT NULL,
	"branch" text NOT NULL,
	"prev_phase" "todo_phase",
	"trigger_source" text DEFAULT 'user' NOT NULL,
	"settlement_code" text,
	"error_message" text,
	"with_plan" boolean DEFAULT false NOT NULL,
	"with_checklist" boolean DEFAULT false NOT NULL,
	"pinned_machine_id" text,
	"agent_id" text NOT NULL,
	"plan_doc_id" text,
	"changes_doc_id" text,
	"pr_url" text,
	"pr_number" integer,
	"diff_hash" text,
	"checkpoint_error" text,
	"branch_pushed_at" bigint,
	"push_error" text,
	"pending_restore" jsonb,
	"session" jsonb NOT NULL,
	"pending_session_resume_at" bigint,
	"usage_by_model" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"worktree_path" text,
	"created_at" bigint NOT NULL,
	"finished_at" bigint,
	"v" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_item" (
	"id" text PRIMARY KEY NOT NULL,
	"todo_id" text NOT NULL,
	"text" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"seq" integer NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chief_thread" (
	"id" text PRIMARY KEY NOT NULL,
	"chief_id" text NOT NULL,
	"title" text NOT NULL,
	"session" jsonb NOT NULL,
	"pending_session_resume_at" bigint,
	"tool_def_hashes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"watched_todos" text[] DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_turn_at" bigint,
	"v" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chief" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"charter" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"kind" text NOT NULL,
	"identifier" text NOT NULL,
	"transport" text NOT NULL,
	"label" text NOT NULL,
	"endpoint" text,
	"enc_config" text,
	"enc_nonce" text,
	"expires_at" bigint,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "document" (
	"id" text PRIMARY KEY NOT NULL,
	"build_id" text NOT NULL,
	"kind" "doc_kind" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_runtime_usage" (
	"machine_id" text NOT NULL,
	"runtime" text NOT NULL,
	"fetched_at" bigint NOT NULL,
	"status" text NOT NULL,
	"account" jsonb NOT NULL,
	"windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	CONSTRAINT "machine_runtime_usage_machine_id_runtime_pk" PRIMARY KEY("machine_id","runtime")
);
--> statement-breakpoint
CREATE TABLE "machine" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"device_id" text NOT NULL,
	"enrolled_by" text NOT NULL,
	"build_enabled" boolean DEFAULT true NOT NULL,
	"shell_enabled" boolean DEFAULT false NOT NULL,
	"max_concurrent_tasks" integer DEFAULT 6 NOT NULL,
	"cli_version" text,
	"workspaces_dir" text,
	"runtimes" text[] DEFAULT '{}' NOT NULL,
	"disabled_runtimes" text[] DEFAULT '{}' NOT NULL,
	"arch" text,
	"runner" text,
	"platform" text,
	"hardware" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tailnet_addr" text,
	"tunnel_error" text,
	"perf" jsonb,
	"is_online" boolean DEFAULT false NOT NULL,
	"last_heartbeat_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"member_type" "member_type" NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"joined_at" bigint NOT NULL,
	"v" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text DEFAULT 'external' NOT NULL,
	"repo_kind" text DEFAULT 'other' NOT NULL,
	"repo_full_name" text,
	"repo_url" text,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"description" text,
	"icon_url" text,
	"next_seq_num" integer DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"kind" text NOT NULL,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text,
	"api" text,
	"compat" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enc_api_key" text,
	"enc_nonce" text,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_credential" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"username" text,
	"enc_token" text NOT NULL,
	"enc_nonce" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"revoked_at" bigint
);
--> statement-breakpoint
CREATE TABLE "schedule" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"todo_id" text NOT NULL,
	"kind" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text NOT NULL,
	"agent_id" text,
	"machine_id" text,
	"automatic" boolean DEFAULT true NOT NULL,
	"last_fired_at" bigint,
	"last_outcome" text,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "secret" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text,
	"scope" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enc_value" text NOT NULL,
	"enc_nonce" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"storage_path" text NOT NULL,
	"size_bytes" bigint,
	"file_count" integer,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "sse_event" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sse_event_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"team_id" text NOT NULL,
	"scope" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "step_credential" (
	"step_id" text PRIMARY KEY NOT NULL,
	"enc_payload" text NOT NULL,
	"enc_nonce" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"consumed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "step" (
	"id" text PRIMARY KEY NOT NULL,
	"build_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"status" "step_status" DEFAULT 'queued' NOT NULL,
	"claimed_at" bigint,
	"heartbeat_at" bigint,
	"finished_at" bigint,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"storage_quota" bigint DEFAULT 1073741824 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "todo" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"seq_num" integer NOT NULL,
	"owner_member_id" text NOT NULL,
	"agent_id" text,
	"title" text NOT NULL,
	"spec" text,
	"tag_ids" text[] DEFAULT '{}' NOT NULL,
	"phase" "todo_phase" DEFAULT 'todo' NOT NULL,
	"plan_first" boolean DEFAULT true NOT NULL,
	"separate_plan_build" boolean DEFAULT false NOT NULL,
	"with_checklist" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"google_id" text,
	"github_id" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "agent_connection_grant" ADD CONSTRAINT "agent_connection_grant_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connection_grant" ADD CONSTRAINT "agent_connection_grant_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill" ADD CONSTRAINT "agent_skill_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill" ADD CONSTRAINT "agent_skill_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_message" ADD CONSTRAINT "build_message_build_id_build_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."build"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build" ADD CONSTRAINT "build_todo_id_todo_id_fk" FOREIGN KEY ("todo_id") REFERENCES "public"."todo"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build" ADD CONSTRAINT "build_pinned_machine_id_machine_id_fk" FOREIGN KEY ("pinned_machine_id") REFERENCES "public"."machine"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build" ADD CONSTRAINT "build_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_item" ADD CONSTRAINT "checklist_item_todo_id_todo_id_fk" FOREIGN KEY ("todo_id") REFERENCES "public"."todo"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chief_thread" ADD CONSTRAINT "chief_thread_chief_id_chief_id_fk" FOREIGN KEY ("chief_id") REFERENCES "public"."chief"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chief" ADD CONSTRAINT "chief_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chief" ADD CONSTRAINT "chief_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chief" ADD CONSTRAINT "chief_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_build_id_build_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."build"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_runtime_usage" ADD CONSTRAINT "machine_runtime_usage_machine_id_machine_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machine"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine" ADD CONSTRAINT "machine_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider" ADD CONSTRAINT "provider_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_credential" ADD CONSTRAINT "repo_credential_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_todo_id_todo_id_fk" FOREIGN KEY ("todo_id") REFERENCES "public"."todo"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_machine_id_machine_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machine"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_credential" ADD CONSTRAINT "step_credential_step_id_step_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."step"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step" ADD CONSTRAINT "step_build_id_build_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."build"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step" ADD CONSTRAINT "step_machine_id_machine_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machine"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo" ADD CONSTRAINT "todo_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo" ADD CONSTRAINT "todo_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_agent_idx" ON "agent_memory" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_team_idx" ON "agent" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "apikey_user_idx" ON "api_key" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_team_created_idx" ON "audit_event" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE INDEX "message_build_seq_idx" ON "build_message" USING btree ("build_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "build_todo_n_uq" ON "build" USING btree ("todo_id","n");--> statement-breakpoint
CREATE INDEX "build_todo_idx" ON "build" USING btree ("todo_id");--> statement-breakpoint
CREATE INDEX "checklist_todo_idx" ON "checklist_item" USING btree ("todo_id","seq");--> statement-breakpoint
CREATE INDEX "thread_chief_idx" ON "chief_thread" USING btree ("chief_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chief_user_team_uq" ON "chief" USING btree ("user_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_team_identifier_uq" ON "connection" USING btree ("team_id","identifier");--> statement-breakpoint
CREATE INDEX "doc_build_kind_idx" ON "document" USING btree ("build_id","kind");--> statement-breakpoint
CREATE INDEX "machine_team_idx" ON "machine" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_team_actor_type_uq" ON "member" USING btree ("team_id","actor_id","member_type");--> statement-breakpoint
CREATE INDEX "member_team_idx" ON "member" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "project_team_idx" ON "project" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "provider_team_idx" ON "provider" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "schedule_team_idx" ON "schedule" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "secret_scope_name_uq" ON "secret" USING btree ("team_id","project_id","name");--> statement-breakpoint
CREATE INDEX "skill_team_idx" ON "skill" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "sse_scope_seq_idx" ON "sse_event" USING btree ("scope","seq");--> statement-breakpoint
CREATE INDEX "step_status_machine_idx" ON "step" USING btree ("status","machine_id");--> statement-breakpoint
CREATE INDEX "step_build_idx" ON "step" USING btree ("build_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_project_name_uq" ON "tag" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "todo_project_seq_uq" ON "todo" USING btree ("project_id","seq_num");--> statement-breakpoint
CREATE INDEX "todo_project_phase_idx" ON "todo" USING btree ("project_id","phase");