import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePayload } from '../src/parity.mjs';

test('payload parity normalizes only compiler-owned scope tokens', () => {
  assert.deepEqual(
    normalizePayload([
      {
        effectiveSelector: '.hero-title[data-astro-cid-a1b2]',
        file: 'src/pages/index.astro',
        line: 8,
        media: null,
        range: { end: 40, start: 10 },
        scoped: true,
        selector: '.hero-title',
        styleBlockIndex: 0,
      },
      {
        effectiveSelector: '.hero-title:where(.astro-c3d4)',
        file: 'src/pages/where.astro',
        line: 5,
        media: null,
        range: { end: 20, start: 2 },
        scoped: true,
        selector: '.hero-title',
        styleBlockIndex: 0,
      },
    ]),
    [
      {
        effectiveSelector: '.hero-title[data-astro-cid-<scope>]',
        file: 'src/pages/index.astro',
        line: 8,
        media: null,
        range: { end: 40, start: 10 },
        scoped: true,
        selector: '.hero-title',
        styleBlockIndex: 0,
      },
      {
        effectiveSelector: '.hero-title:where(.astro-<scope>)',
        file: 'src/pages/where.astro',
        line: 5,
        media: null,
        range: { end: 20, start: 2 },
        scoped: true,
        selector: '.hero-title',
        styleBlockIndex: 0,
      },
    ],
  );
});
