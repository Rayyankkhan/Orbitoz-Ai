/**
 * `vitestBase` is the one place every package's test config is built.
 *
 * These tests exist because the helper previously destructured a fixed set of
 * options and dropped the rest on the floor. `vitest.integration.config.ts`
 * passed `fileParallelism`, `pool`, `poolOptions`, `testTimeout` and
 * `hookTimeout` and got none of them — the integration suite was running
 * parallel against one Redis with the default 5s timeout, silently, with a
 * green tick. Nothing failed; the configuration was just not applied.
 *
 * The invariant under test: a per-package option either reaches `test` as
 * passed, or is one this helper deliberately owns.
 */
import { describe, expect, it } from 'vitest';
import { vitestBase } from '../vitest.base.js';

describe('vitestBase forwarding', () => {
  it('forwards Vitest options it does not own', () => {
    const config = vitestBase({
      fileParallelism: false,
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
      testTimeout: 30_000,
      hookTimeout: 30_000,
    });

    expect(config.test).toMatchObject({
      fileParallelism: false,
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
      testTimeout: 30_000,
      hookTimeout: 30_000,
    });
  });

  it('forwards an arbitrary option the helper has never heard of', () => {
    // The point of a spread rather than an allowlist: a Vitest option added
    // upstream is usable the day it exists, without editing this file.
    const config = vitestBase({ sequence: { shuffle: true } as never });

    expect(config.test?.sequence).toEqual({ shuffle: true });
  });

  it('turns the coverage option into globs rather than forwarding it verbatim', () => {
    const config = vitestBase({ coverage: ['src/**/*.ts'] });

    expect(config.test?.coverage).toMatchObject({
      provider: 'v8',
      include: ['src/**/*.ts'],
    });
    // A forwarded array would have replaced the whole coverage object.
    expect(config.test?.coverage).toHaveProperty('reporter');
    expect(config.test?.coverage).toHaveProperty('exclude');
  });

  it('merges coverageExclude into coverage.exclude without leaking it into test', () => {
    const config = vitestBase({ coverageExclude: ['**/main.ts'] });

    expect(config.test?.coverage?.exclude).toContain('**/main.ts');
    expect(config.test).not.toHaveProperty('coverageExclude');
  });

  it('keeps its own exclusions when a caller passes its own', () => {
    // `exclude` is shared by both include globs and coverage; the helper owns it
    // because every package needs node_modules and dist/ gone for the same reason.
    const config = vitestBase({ exclude: ['test/**/*.test.ts'] as never });

    expect(config.test?.exclude).toContain('**/node_modules/**');
    expect(config.test?.exclude).toContain('**/dist/**');
  });

  it('applies the defaults when given nothing', () => {
    const config = vitestBase();

    expect(config.test?.environment).toBe('node');
    expect(config.test?.include).toEqual([
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'scripts/**/*.test.ts',
    ]);
    expect(config.test?.clearMocks).toBe(true);
    expect(config.test?.restoreMocks).toBe(true);
  });
});
