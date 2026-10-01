-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED');

-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('FREE', 'STARTER', 'GROWTH', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "TenantRole" AS ENUM ('OWNER', 'ADMIN', 'DEVELOPER', 'ANALYST', 'BILLING', 'VIEWER');

-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('ENABLED', 'DISABLED');

-- CreateEnum
CREATE TYPE "RoutingStrategy" AS ENUM ('FIXED', 'COST_OPTIMIZED', 'QUALITY_OPTIMIZED', 'LATENCY_OPTIMIZED', 'BALANCED', 'FAILOVER');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'DEAD_LETTERED');

-- CreateEnum
CREATE TYPE "ApiKeyScope" AS ENUM ('INFERENCE_READ', 'INFERENCE_WRITE', 'USAGE_READ', 'TENANT_READ', 'TENANT_WRITE');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('TENANT_CREATED', 'TENANT_UPDATED', 'TENANT_SUSPENDED', 'MEMBER_INVITED', 'MEMBER_ROLE_CHANGED', 'MEMBER_REMOVED', 'API_KEY_CREATED', 'API_KEY_REVOKED', 'INFERENCE_REQUESTED', 'SIGN_IN', 'SIGN_IN_FAILED', 'SIGN_OUT', 'TOKEN_REFRESHED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "email_verified_at" TIMESTAMP(3),
    "password_hash" VARCHAR(255) NOT NULL,
    "name" VARCHAR(200),
    "avatar_url" VARCHAR(2048),
    "locale" VARCHAR(16) NOT NULL DEFAULT 'en',
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "is_platform_admin" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "family_id" UUID NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" VARCHAR(64),
    "replaced_by_id" UUID,
    "user_agent" VARCHAR(512),
    "ip_address" VARCHAR(45),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(63) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "custom_domain" VARCHAR(253),
    "status" "TenantStatus" NOT NULL DEFAULT 'TRIALING',
    "plan" "SubscriptionPlan" NOT NULL DEFAULT 'FREE',
    "monthly_request_quota" INTEGER NOT NULL DEFAULT 1000,
    "max_seats" INTEGER NOT NULL DEFAULT 3,
    "max_rpm" INTEGER NOT NULL DEFAULT 10,
    "default_routing_strategy" "RoutingStrategy" NOT NULL DEFAULT 'BALANCED',
    "trial_ends_at" TIMESTAMP(3),
    "suspended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "TenantRole" NOT NULL DEFAULT 'VIEWER',
    "invited_by_id" UUID,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("tenant_id","user_id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "tenant_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "role" "TenantRole" NOT NULL DEFAULT 'VIEWER',
    "token_hash" VARCHAR(128) NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "inviter_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMP(3),

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("tenant_id","email")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "tenant_id" UUID NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "seats" INTEGER NOT NULL DEFAULT 1,
    "provider_customer_ref" VARCHAR(255),
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "prefix" VARCHAR(12) NOT NULL,
    "secret_hash" VARCHAR(128) NOT NULL,
    "scopes" "ApiKeyScope"[] DEFAULT ARRAY['INFERENCE_READ', 'INFERENCE_WRITE']::"ApiKeyScope"[],
    "rate_limit_rpm" INTEGER,
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "provider_models" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "model_id" VARCHAR(128) NOT NULL,
    "display_name" VARCHAR(200),
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "context_window" INTEGER,
    "max_output_tokens" INTEGER,
    "input_cost_per_m_tokens" INTEGER NOT NULL,
    "output_cost_per_m_tokens" INTEGER NOT NULL,
    "quality_score" INTEGER NOT NULL DEFAULT 5000,
    "latency_score" INTEGER NOT NULL DEFAULT 5000,
    "is_deprecated" BOOLEAN NOT NULL DEFAULT false,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_providers" (
    "tenant_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "status" "ProviderStatus" NOT NULL DEFAULT 'ENABLED',
    "weight" INTEGER NOT NULL DEFAULT 100,
    "credential_ref" VARCHAR(255),
    "price_multiplier_bps" INTEGER NOT NULL DEFAULT 10000,
    "max_input_tokens_per_min" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_providers_pkey" PRIMARY KEY ("tenant_id","model_id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "title" VARCHAR(300),
    "provider" VARCHAR(64),
    "model" VARCHAR(128),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "inference_jobs" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "conversation_id" UUID,
    "queue_job_id" VARCHAR(128),
    "idempotency_key" VARCHAR(255),
    "requested_model" VARCHAR(128) NOT NULL,
    "provider" VARCHAR(64),
    "routing_strategy" "RoutingStrategy" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd_micros" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER,
    "request_payload" JSONB NOT NULL DEFAULT '{}',
    "response_payload" JSONB,
    "error_code" VARCHAR(64),
    "error_message" VARCHAR(2000),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "inference_jobs_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "provider_attempts" (
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "model" VARCHAR(128) NOT NULL,
    "success" BOOLEAN NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "error_code" VARCHAR(64),
    "error_message" VARCHAR(2000),
    "attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_attempts_pkey" PRIMARY KEY ("tenant_id","job_id","attempt_no")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "tenant_id" UUID NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "job_id" UUID,
    "model" VARCHAR(128) NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "strategy" "RoutingStrategy" NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd_micros" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "error_code" VARCHAR(64),
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "usage_rollups" (
    "tenant_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "model" VARCHAR(128) NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd_micros" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_rollups_pkey" PRIMARY KEY ("tenant_id","day","model")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "job_id" UUID,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("tenant_id","key")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "tenant_id" UUID NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "actor_id" UUID,
    "actor_email" VARCHAR(320),
    "action" "AuditAction" NOT NULL,
    "target" VARCHAR(300),
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(512),
    "request_id" VARCHAR(64),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_revoked_at_idx" ON "refresh_tokens"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_custom_domain_key" ON "tenants"("custom_domain");

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- CreateIndex
CREATE INDEX "tenants_custom_domain_idx" ON "tenants"("custom_domain");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE INDEX "memberships_tenant_id_role_idx" ON "memberships"("tenant_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_secret_hash_key" ON "api_keys"("secret_hash");

-- CreateIndex
CREATE INDEX "api_keys_tenant_id_revoked_at_idx" ON "api_keys"("tenant_id", "revoked_at");

-- CreateIndex
CREATE INDEX "api_keys_expires_at_idx" ON "api_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_tenant_id_prefix_key" ON "api_keys"("tenant_id", "prefix");

-- CreateIndex
CREATE INDEX "provider_models_provider_is_enabled_idx" ON "provider_models"("provider", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "provider_models_provider_model_id_key" ON "provider_models"("provider", "model_id");

-- CreateIndex
CREATE INDEX "tenant_providers_tenant_id_status_idx" ON "tenant_providers"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_updated_at_idx" ON "conversations"("tenant_id", "updated_at");

-- CreateIndex
CREATE INDEX "inference_jobs_tenant_id_status_queued_at_idx" ON "inference_jobs"("tenant_id", "status", "queued_at");

-- CreateIndex
CREATE INDEX "inference_jobs_tenant_id_conversation_id_idx" ON "inference_jobs"("tenant_id", "conversation_id");

-- CreateIndex
CREATE INDEX "inference_jobs_queue_job_id_idx" ON "inference_jobs"("queue_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "inference_jobs_tenant_id_idempotency_key_key" ON "inference_jobs"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "provider_attempts_job_id_idx" ON "provider_attempts"("job_id");

-- CreateIndex
CREATE INDEX "usage_records_tenant_id_occurred_at_idx" ON "usage_records"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "usage_records_tenant_id_model_occurred_at_idx" ON "usage_records"("tenant_id", "model", "occurred_at");

-- CreateIndex
CREATE INDEX "usage_rollups_tenant_id_day_idx" ON "usage_rollups"("tenant_id", "day");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_occurred_at_idx" ON "audit_logs"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_action_occurred_at_idx" ON "audit_logs"("tenant_id", "action", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs"("actor_id");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_providers" ADD CONSTRAINT "tenant_providers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_providers" ADD CONSTRAINT "tenant_providers_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "provider_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inference_jobs" ADD CONSTRAINT "inference_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inference_jobs" ADD CONSTRAINT "inference_jobs_conversation_id_tenant_id_fkey" FOREIGN KEY ("conversation_id", "tenant_id") REFERENCES "conversations"("id", "tenant_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_attempts" ADD CONSTRAINT "provider_attempts_job_id_tenant_id_fkey" FOREIGN KEY ("job_id", "tenant_id") REFERENCES "inference_jobs"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_rollups" ADD CONSTRAINT "usage_rollups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
