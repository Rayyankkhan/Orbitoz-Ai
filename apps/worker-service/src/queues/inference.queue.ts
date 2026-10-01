/**
 * Queue naming, taken from the shared contract rather than re-declared.
 *
 * The gateway produces these jobs and this service consumes them, so both read
 * the same constants from `@orbitoz/shared-types`. A locally-defined copy
 * would drift the first time someone renamed a queue, and the failure mode is a
 * worker silently idling on a queue nobody writes to.
 */
import { DEFAULT_JOB_OPTIONS } from '@orbitoz/shared-types';

export { QUEUE_NAMES, INFERENCE_JOB } from '@orbitoz/shared-types';
export type { BaseJob, InferenceJobPayload } from '@orbitoz/shared-types';

/** Retry and retention policy, also owned by the shared contract. */
export const INFERENCE_JOB_OPTIONS = DEFAULT_JOB_OPTIONS;
