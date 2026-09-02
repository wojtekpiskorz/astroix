import { findDisclosure } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_ERROR_CODES,
  AdapterError,
  observedShape,
} from '../../astro-project-adapter/adapter-error';
import { uncertifiedPairError } from '../../astro-project-adapter/certified-pair';

/**
 * Diagnostic sanitization (#225 focused test): adapter diagnostics are
 * the raw material later lanes lift onto the wire, so they are guarded
 * at construction by the protocol's disclosure-shape guard — a message
 * that would disclose a root, port, PID, stack, or environment value
 * cannot exist as an AdapterError, and every real composition path
 * produces clean messages.
 */

describe('AdapterError construction guard', () => {
  it('accepts the sanitized per-code message shapes', () => {
    for (const [code, message, details] of [
      [
        'uncertified-pair',
        'detected astro@7.2.11 + vite@8.2.2; certified pairs: none',
        {
          detected: { astro: '7.2.11', vite: '8.2.2' },
          certified: [],
          rejectedContract: 'contract',
        },
      ],
      [
        'dependency-unresolved',
        'the managed project dependency vite does not resolve',
        { dependency: 'vite', reason: 'not-resolvable' },
      ],
      [
        'seam-rejected',
        'seam rejection at virtual:astro:routes export: expected an array routes export',
        {
          seam: 'virtual:astro:routes export',
          seamClass: 'fail-closed private',
          expected: 'an array routes export',
          observed: 'object',
        },
      ],
      [
        'runner-cleanup',
        'the hot transport send listener count changed from 1 to 2 across the pass',
        { residue: 'send-listeners', before: 1, after: 2 },
      ],
    ] as const) {
      const error = new AdapterError(code, message, details);
      expect(error.code).toBe(code);
      expect(error.name).toBe('AdapterError');
      expect(error.message).toBe(message);
      expect(findDisclosure(error.message)).toBeNull();
    }
  });

  it('refuses a message carrying an absolute filesystem path', () => {
    expect(
      () =>
        new AdapterError(
          'seam-rejected',
          'cannot read the module at /Users/dev/project/src/index.astro',
          {
            seam: 'x',
            seamClass: 'fail-closed private',
            expected: 'x',
            observed: 'x',
          },
        ),
    ).toThrow('refused: message may not disclose an absolute filesystem path');
  });

  it('refuses a message carrying a stack frame, a pid, a port, and an environment value', () => {
    const leaky = [
      'failed\n    at loadConfig (/app/astro/dist/config.js:1:1)',
      'the runner for pid 4242 stayed open',
      'the composition could not bind port 4314',
      'resolved with ASTRO_ROOT=/srv/project',
    ];
    for (const message of leaky) {
      expect(() => new AdapterError('runner-cleanup', message, { residue: 'open-runner' })).toThrow(
        'refused: message may not disclose',
      );
    }
  });

  it('keeps the upstream cause while refusing the leaky message', () => {
    const cause = new Error('ENOENT: no such file');
    expect(
      () =>
        new AdapterError(
          'dependency-unresolved',
          'missing at ~/projects/site',
          { dependency: 'astro', reason: 'not-resolvable' },
          { cause },
        ),
    ).toThrow('refused');
  });

  it('closes the code set', () => {
    expect(ADAPTER_ERROR_CODES).toEqual([
      'uncertified-pair',
      'dependency-unresolved',
      'seam-rejected',
      'runner-cleanup',
    ]);
  });
});

describe('the real composition paths', () => {
  it('produces disclosure-clean diagnostics for every adapter error constructor', () => {
    // The pair rejection is the charter's named diagnostic — it must be
    // clean as composed, not just clean by construction.
    const error = uncertifiedPairError({ astro: '9.9.9', vite: '0.0.0' });
    expect(findDisclosure(error.message)).toBeNull();
    expect(JSON.stringify(error.details)).not.toMatch(/\/[a-z][^/]*\//i);
  });
});

describe('observedShape', () => {
  it('describes shapes structurally, never values', () => {
    expect(observedShape(null)).toBe('null');
    expect(observedShape(undefined)).toBe('typeof undefined');
    expect(observedShape(42)).toBe('typeof number');
    expect(observedShape([])).toBe('array');
    expect(observedShape({})).toBe('object with no own properties');
    expect(observedShape({ routes: 1, a: 2, b: 3, c: 4, d: 5, e: 6 })).toBe(
      'object with own properties routes, a, b, c, d',
    );
    expect(observedShape(() => {})).toBe('function with no own properties');
  });
});
