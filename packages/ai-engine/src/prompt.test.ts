/**
 * Prompt templates.
 *
 * The central rule under test: a missing variable throws. Rendering it as an
 * empty string produces a plausible prompt about the wrong thing, which is the
 * failure mode the whole module exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import {
  PromptTemplateError,
  referencedPaths,
  renderPrompt,
  renderPromptMap,
  resolvePath,
} from './prompt.js';

describe('resolvePath', () => {
  it('walks dotted paths and array indices', () => {
    const scope = { customer: { name: 'Ada' }, items: [{ id: 7 }] };
    expect(resolvePath(scope, 'customer.name')).toBe('Ada');
    expect(resolvePath(scope, 'items.0.id')).toBe(7);
  });

  it('returns undefined for a missing hop rather than throwing', () => {
    expect(resolvePath({ a: {} }, 'a.b.c')).toBeUndefined();
  });

  it('refuses prototype-polluting paths', () => {
    expect(resolvePath({}, '__proto__.constructor')).toBeUndefined();
    expect(resolvePath({}, 'a.constructor')).toBeUndefined();
  });
});

describe('renderPrompt', () => {
  it('interpolates values and stringifies objects as JSON', () => {
    const rendered = renderPrompt('Hi {{name}}, here is {{payload}}', {
      name: 'Ada',
      payload: { total: 3 },
    });
    expect(rendered).toBe('Hi Ada, here is {"total":3}');
  });

  it('throws on a missing required variable', () => {
    expect(() => renderPrompt('Summarise {{customer.name}}', {})).toThrow(PromptTemplateError);
  });

  it('de-duplicates and sorts the missing-variable report', () => {
    const error = (() => {
      try {
        renderPrompt('{{b}} {{a}} {{b}}', {});
        return null;
      } catch (thrown: unknown) {
        return thrown as PromptTemplateError;
      }
    })();
    expect(error?.message).toContain('a, b');
  });

  it('renders an optional missing path as empty', () => {
    expect(renderPrompt('Hi{{suffix}}', {}, { optionalPaths: ['suffix'] })).toBe('Hi');
  });

  it('still throws for a required path when another is optional', () => {
    expect(() =>
      renderPrompt('{{required}} {{optional}}', {}, { optionalPaths: ['optional'] }),
    ).toThrow(/required/);
  });
});

describe('referencedPaths', () => {
  it('lists each path once, in first-appearance order', () => {
    expect(referencedPaths('{{b}} {{a}} {{b}}')).toEqual(['b', 'a']);
  });
});

describe('renderPromptMap', () => {
  it('renders every template in a record', () => {
    expect(
      renderPromptMap(
        { system: 'You are {{role}}.', user: 'Hi {{name}}' },
        { role: 'terse', name: 'Ada' },
      ),
    ).toEqual({
      system: 'You are terse.',
      user: 'Hi Ada',
    });
  });
});
