/**
 * Browser-safe type surface.
 *
 * Two generated barrels are combined here:
 *
 *   browser.ts — result types under their plain names (`Tenant`, `InferenceJob`).
 *               No Node or server-only dependencies, so a Next.js client
 *               component may reference them. `import type` only, so nothing is
 *               emitted at runtime.
 *   models/*.ts — the `*WhereInput` / `*CreateInput` / `*UpdateInput` shapes
 *               used when building queries.
 *
 *   import type { InferenceJob, InferenceJobWhereInput } from '@orbitoz/database/types';
 */
export type {
  User,
  RefreshToken,
  Tenant,
  Membership,
  Invitation,
  Subscription,
  ApiKey,
  ProviderModel,
  TenantProvider,
  Conversation,
  InferenceJob,
  ProviderAttempt,
  UsageRecord,
  UsageRollup,
  IdempotencyKey,
  AuditLog,
  ApprovalRequest,
} from '../generated/prisma/browser.js';

export type {
  UserModel,
  UserCreateInput,
  UserUpdateInput,
  UserWhereInput,
  UserWhereUniqueInput,
  TenantModel,
  TenantCreateInput,
  TenantUpdateInput,
  TenantWhereInput,
  TenantWhereUniqueInput,
  MembershipModel,
  MembershipCreateInput,
  MembershipUpdateInput,
  MembershipWhereInput,
  MembershipWhereUniqueInput,
  ApiKeyModel,
  ApiKeyCreateInput,
  ApiKeyUpdateInput,
  ApiKeyWhereInput,
  ApiKeyWhereUniqueInput,
  ConversationModel,
  ConversationCreateInput,
  ConversationUpdateInput,
  ConversationWhereInput,
  ConversationWhereUniqueInput,
  InferenceJobModel,
  InferenceJobCreateInput,
  InferenceJobUpdateInput,
  InferenceJobWhereInput,
  InferenceJobWhereUniqueInput,
  UsageRecordModel,
  UsageRecordCreateInput,
  UsageRecordWhereInput,
  UsageRollupModel,
  UsageRollupWhereInput,
  IdempotencyKeyModel,
  IdempotencyKeyCreateInput,
  IdempotencyKeyWhereInput,
  AuditLogModel,
  AuditLogCreateInput,
  AuditLogWhereInput,
  ApprovalRequestModel,
  ApprovalRequestCreateInput,
  ApprovalRequestUpdateInput,
  ApprovalRequestWhereInput,
  ApprovalRequestWhereUniqueInput,
} from '../generated/prisma/models.js';
