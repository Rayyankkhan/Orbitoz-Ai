/**
 * Browser-safe re-export of the generated Prisma enums.
 *
 * Uses `browser.ts`, which contains no Node.js or server-only dependencies —
 * unlike `client.ts`, which transitively pulls in the query engine. Importing
 * from here in a Next.js client component is therefore safe.
 *
 *   // apps/web/src/components/billing/plan-badge.tsx
 *   import { SubscriptionPlan } from '@orbitoz/database/enums';
 */
export {
  JobStatus,
  ProviderStatus,
  RoutingStrategy,
  SubscriptionPlan,
  SubscriptionStatus,
  TenantRole,
  TenantStatus,
  UserStatus,
  ApiKeyScope,
  AuditAction,
  InvitationStatus,
  ApprovalStatus,
} from '../generated/prisma/enums.js';
