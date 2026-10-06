/**
 * Domain errors for the human-in-the-loop approval flow.
 *
 * Same shape and same intent as `auth/auth.errors.ts`: each carries a canonical
 * `ErrorCode` from `@orbitoz/shared-types`, so the HTTP layer maps through
 * `HTTP_STATUS_BY_ERROR_CODE` instead of hard-coding status numbers, and a
 * client can switch on the code.
 *
 * ---------------------------------------------------------------------------
 * WHY "NOT FOUND" IS DELIBERATELY BLUNT
 * ---------------------------------------------------------------------------
 * `ApprovalNotFoundError` covers an unknown token, a token belonging to another
 * tenant, and a token for a row that has since been purged. The endpoint is
 * public and the token is a capability, so distinguishing those cases would turn
 * it into an oracle: an attacker could mint candidate tokens, or take one real
 * token and probe which tenant it belongs to, and the difference in the response
 * would tell them. One code, one message.
 *
 * `ApprovalExpiredError` is the one exception, because it is not a probe result —
 * the token was valid, and telling the approver their link went stale is the
 * difference between them knowing to ask for a new one and them believing they
 * were sent a broken link.
 */

/** Base class so one `catch` can separate an approval fault from a real fault. */
export class ApprovalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * No approval request matches this token on this tenant.
 *
 * Never distinguishes "unknown" from "belongs to someone else".
 */
export class ApprovalNotFoundError extends ApprovalError {
  constructor() {
    super('APPROVAL_NOT_FOUND', 'This approval link is not valid.');
  }
}

/** The link was valid and its deadline has passed. */
export class ApprovalExpiredError extends ApprovalError {
  constructor(readonly expiresAt: Date) {
    super(
      'APPROVAL_EXPIRED',
      `This approval link expired at ${expiresAt.toISOString()}. Ask for a new one.`,
    );
  }
}

/**
 * The signature did not match.
 *
 * One error for a malformed signature, an unsupported version, a timestamp
 * outside the window and a plain mismatch, with a message that names none of
 * them. Telling a caller *which* check failed turns the endpoint into a padding
 * oracle for guessing the canonical string.
 */
export class ApprovalSignatureInvalidError extends ApprovalError {
  constructor() {
    super(
      'APPROVAL_SIGNATURE_INVALID',
      'This approval request could not be verified. Reload the approval page and try again.',
    );
  }
}

/** The grant's timestamp is outside the accepted window. */
export class ApprovalSignatureExpiredError extends ApprovalError {
  constructor() {
    super(
      'APPROVAL_SIGNATURE_EXPIRED',
      'This approval page has expired. Reload it to get a fresh link.',
    );
  }
}

/**
 * The queue job could not be enqueued after the decision was recorded.
 *
 * A 503, not a 4xx, and deliberately distinct from a bad request: the decision
 * *is* recorded and durable, and the caller should retry so the resume completes.
 * Swallowing this would leave an approved request that never runs.
 */
export class ApprovalDispatchFailedError extends ApprovalError {
  constructor(
    readonly approvalId: string,
    override readonly cause: string,
  ) {
    super(
      'SERVICE_UNAVAILABLE',
      'The approval was recorded but the job could not be queued. Retry the request.',
    );
  }
}
