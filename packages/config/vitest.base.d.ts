import type { ViteUserConfig } from 'vitest/config';

/**
 * Every Vitest `test` option except `coverage`, which this helper reshapes: the
 * caller passes bare source globs and this file turns them into the
 * `coverage.include`/`coverage.exclude` pair, so the caller's array must not be
 * forwarded verbatim as a `coverage` object.
 */
type ForwardedTestOptions = Omit<NonNullable<ViteUserConfig['test']>, 'coverage'>;

/** Per-package overrides accepted by {@link vitestBase}. */
export interface VitestBaseOptions extends ForwardedTestOptions {
  /** Test file globs. */
  include?: string[];
  /** Source globs to measure coverage over. */
  coverage?: string[];
  /** Extra coverage exclusion globs, e.g. process wiring a unit test cannot run. */
  coverageExclude?: string[];
  /** Vitest environment for the package. */
  environment?: string;
}

/**
 * Builds the Vitest config every package extends, so coverage scope, include
 * patterns and environment stay identical across the workspace. Any Vitest
 * option not listed above is forwarded to `test` untouched.
 *
 * @see ./vitest.base.js for the rationale behind Vitest over Jest.
 */
export declare function vitestBase(options?: VitestBaseOptions): ViteUserConfig;
