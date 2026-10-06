-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'APPROVAL_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'APPROVAL_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'APPROVAL_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'APPROVAL_EXPIRED';

-- AlterEnum
ALTER TYPE "JobStatus" ADD VALUE 'AWAITING_APPROVAL';

-- CreateTable
CREATE TABLE "approval_requests" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "job_id" UUID NOT NULL,
    "job_name" VARCHAR(64) NOT NULL DEFAULT 'inference.route',
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "decided_at" TIMESTAMP(3),
    "decision_note" VARCHAR(2000),
    "decision_ip" VARCHAR(45),
    "decision_user_agent" VARCHAR(512),
    "decision_trace_id" VARCHAR(64),
    "dispatched_at" TIMESTAMP(3),
    "dispatch_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_token_hash_key" ON "approval_requests"("token_hash");

-- CreateIndex
CREATE INDEX "approval_requests_tenant_id_status_created_at_idx" ON "approval_requests"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "approval_requests_tenant_id_job_id_idx" ON "approval_requests"("tenant_id", "job_id");

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_job_id_fkey" FOREIGN KEY ("tenant_id", "job_id") REFERENCES "inference_jobs"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
