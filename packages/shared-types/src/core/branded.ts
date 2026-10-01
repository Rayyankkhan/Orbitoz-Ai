/**
 * Branded primitive types.
 *
 * A branded `TenantId` is structurally incompatible with an `ApiKeyId` at the
 * type level, so `findUnique({ where: { id: tenantId } })` fails to compile
 * instead of silently querying the wrong table. This is the single cheapest
 * defence against cross-tenant data bugs in a multi-tenant system.
 */

declare const brand: unique symbol;

/** Attaches a compile-time-only tag to a primitive type. */
export type Branded<T, TBrand extends string> = T & { readonly [brand]: TBrand };

export type TenantId = Branded<string, 'TenantId'>;
export type UserId = Branded<string, 'UserId'>;
export type MembershipId = Branded<string, 'MembershipId'>;
export type ApiKeyId = Branded<string, 'ApiKeyId'>;
export type OrganizationId = Branded<string, 'OrganizationId'>;
export type ConversationId = Branded<string, 'ConversationId'>;
export type JobId = Branded<string, 'JobId'>;
export type RequestId = Branded<string, 'RequestId'>;
export type Timestamp = Branded<string, 'Timestamp'>;

/** Narrowing helpers — the only sanctioned way to produce a branded value. */
export const asTenantId = (value: string): TenantId => value as TenantId;
export const asUserId = (value: string): UserId => value as UserId;
export const asMembershipId = (value: string): MembershipId => value as MembershipId;
export const asApiKeyId = (value: string): ApiKeyId => value as ApiKeyId;
export const asOrganizationId = (value: string): OrganizationId => value as OrganizationId;
export const asConversationId = (value: string): ConversationId => value as ConversationId;
export const asJobId = (value: string): JobId => value as JobId;
export const asRequestId = (value: string): RequestId => value as RequestId;

/** ISO-8601 timestamp, branded so it cannot be confused with a plain string. */
export const asTimestamp = (value: string): Timestamp => value as Timestamp;
export const now = (): Timestamp => new Date().toISOString() as Timestamp;
