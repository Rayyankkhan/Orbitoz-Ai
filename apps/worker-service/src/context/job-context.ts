/**
 * Job context: the bridge from a Redis payload back to ambient tenant scope.
 *
 * A worker has no HTTP request to inherit a tenant from, so it must establish
 * one per job. This is the single largest source of cross-tenant bugs in worker
 * code: a job for tenant A silently reading or writing tenant B's rows because
 * the scope was never entered, or was entered with a value taken from somewhere
 * other than the envelope.
 *
 * So context comes from exactly one place — `job.data` — and entering it is the
 * only supported way to run a processor. Everything downstream (Prisma's tenant
 * extension, `requireTenantId()`) reads `AsyncLocalStorage`, so a processor three
 * calls deep still issues a correctly scoped query without anyone having
 * threaded a tenant id through every signature.
 */
import type { Job } from 'bullmq';
import {
  validateJobContext,
  type BaseJob,
  type TenantId,
  type UserId,
} from '@orbitoz/shared-types';
import { runWithTenant } from '@orbitoz/database';

/** The ambient context established for the duration of one job. */
export interface JobContext {
  readonly tenantId: TenantId;
  /** Null for system-initiated jobs with no human actor. */
  readonly userId: UserId | null;
  readonly traceId: string;
  readonly jobId: string;
}

/**
 * Thrown when a payload does not carry the required context.
 *
 * A distinct error from a processor failure because the response is different:
 * this is a poison payload that no retry can fix, so it skips the retry budget
 * and goes straight to the DLQ.
 */
export class JobContextError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `Job payload is missing required context (${problems.join('; ')}). A worker cannot ` +
        'process a job it cannot attribute to a tenant.',
    );
    this.name = 'JobContextError';
  }
}

/**
 * Extracts and validates the context from a restored payload.
 *
 * Payloads come back from Redis as untyped JSON — nothing but this check
 * enforces the shape. Returns the narrowed envelope rather than just the context
 * because processors need the payload too, and re-reading `job.data` unvalidated
 * would defeat the point.
 *
 * @throws {JobContextError} when a required field is missing or malformed.
 */
export function jobContextOf<T>(job: Job<BaseJob<T>>): {
  readonly context: JobContext;
  readonly envelope: BaseJob<T>;
} {
  const result = validateJobContext(job.data);
  if (!result.ok) throw new JobContextError(result.problems);

  const envelope = result.context as BaseJob<T>;
  return {
    envelope,
    context: {
      tenantId: envelope.tenantId,
      userId: envelope.userId,
      traceId: envelope.traceId,
      jobId: envelope.id,
    },
  };
}

/**
 * Runs `fn` with the job's tenant context active.
 *
 * Every query inside `fn` is automatically scoped, because the Prisma tenant
 * extension reads the ambient scope. A processor that forgets to pass a tenant id
 * cannot accidentally read another tenant's rows — the extension throws instead.
 *
 * Declared `async` rather than returning `runWithTenant(...)` directly, and the
 * distinction is load-bearing: a non-async function that throws before its first
 * `await` throws **synchronously**, so a caller writing
 * `withJobContext(job, fn).catch(handle)` would get an uncaught exception instead
 * of a rejection, and the error would escape the worker's own try/catch. Async
 * makes every failure arrive as a rejection, which is what every caller expects
 * from a function returning a promise.
 *
 * @throws {JobContextError} when the payload lacks required context, as a
 *   rejected promise.
 */
export async function withJobContext<T, R>(
  job: Job<BaseJob<T>>,
  fn: (context: JobContext) => Promise<R>,
): Promise<R> {
  const { context } = jobContextOf(job);

  return runWithTenant(
    {
      tenantId: context.tenantId,
      // `requestId` is the ambient field; `traceId` is the queue contract's name
      // for the same value, so a job's log lines join up with the request that
      // enqueued it.
      requestId: context.traceId,
      userId: context.userId ?? undefined,
    },
    () => fn(context),
  );
}

/**
 * Whether a failure should be retried.
 *
 * Retryable by default, because the common cause is a provider or network blip
 * and the cost of one extra attempt is seconds. Non-retryable signals a payload
 * or configuration problem that will fail identically every time, and burning
 * four attempts on it delays the DLQ signal by seven seconds for nothing.
 *
 * Marked non-retryable by error class or by an explicit `retryable === false`
 * property, which is how a processor opts a specific failure out without having
 * to enumerate every error type it can throw.
 */
export function isRetryable(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'retryable' in error) {
    const flag = (error as { readonly retryable?: unknown }).retryable;
    if (typeof flag === 'boolean') return flag;
  }

  if (error instanceof JobContextError) return false;

  return true;
}
