import type { ViteUserConfig } from 'vitest/config';

/** Per-package overrides accepted by {@link vitestBase}. */
export interface VitestBaseOptions {
  /** Test file globs. */
  include?: string[];
  /** Source globs to measure coverage over. */
  coverage?: string[];
  /** Vitest environment for the package. */
  environment?: string;
  /** Coverage threshold percentage. */
  threshold?: number;
}

/**
 * Builds the Vitest config every package extends, so coverage thresholds,
 * include patterns and environment stay identical across the workspace.
 *
 * @see ./vitest.base.js for the rationale behind Vitest over Jest.
 */
export declare function vitestBase(options?: VitestBaseOptions): ViteUserConfig;
