import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildStaticIndex,
  indexAstroSource,
  joinEffectiveSelectors,
} from '../src/index-payload.mjs';

const fixtureRoot = fileURLToPath(new URL('../fixture/', import.meta.url));

test('the static index keeps global and scoped source selectors separate', async () => {
  const records = await buildStaticIndex(fixtureRoot);

  assert.deepEqual(
    records.map(({ file, scoped, selector, styleBlockIndex }) => ({
      file,
      scoped,
      selector,
      styleBlockIndex,
    })),
    [
      {
        file: 'src/pages/home.css',
        scoped: false,
        selector: '.hero',
        styleBlockIndex: null,
      },
      {
        file: 'src/pages/home.css',
        scoped: false,
        selector: '.hero-title',
        styleBlockIndex: null,
      },
      {
        file: 'src/pages/home.css',
        scoped: false,
        selector: '.hero-lead',
        styleBlockIndex: null,
      },
      {
        file: 'src/pages/index.astro',
        scoped: true,
        selector: '.hero-title',
        styleBlockIndex: 0,
      },
    ],
  );
});

test('the compiled CSS join accepts attribute and where forms without synthesizing either', async () => {
  const records = await buildStaticIndex(fixtureRoot);

  for (const effectiveSelector of [
    '.hero-title[data-astro-cid-proof]',
    '.hero-title:where([data-astro-cid-proof])',
  ]) {
    const payload = joinEffectiveSelectors(records, [
      {
        content: `${effectiveSelector} { color: #1e293b; }`,
        id: `${fixtureRoot}/src/pages/index.astro?astro&type=style&index=0&lang.css`,
        url: '/src/pages/index.astro?astro&type=style&index=0&lang.css',
      },
    ]);
    assert.equal(payload.find((record) => record.scoped)?.effectiveSelector, effectiveSelector);
  }
});

test('the compiled CSS join fails closed on a rule-count mismatch', async () => {
  const records = await buildStaticIndex(fixtureRoot);
  assert.throws(
    () =>
      joinEffectiveSelectors(records, [
        {
          content: '.unrelated[data-astro-cid-proof] {}\n.extra[data-astro-cid-proof] {}',
          id: `${fixtureRoot}/src/pages/index.astro?astro&type=style&index=0&lang.css`,
          url: '/src/pages/index.astro?astro&type=style&index=0&lang.css',
        },
      ]),
    /AstroProjectAdapter private seam rejection: compiled CSS rule count 2 does not match static scoped rule count 1/,
  );
});

test('the compiled CSS join fails closed on a same-count rule reorder', () => {
  const records = [
    {
      file: 'src/pages/index.astro',
      line: 1,
      media: null,
      range: { end: 20, start: 0 },
      scoped: true,
      selector: '.first',
      styleBlockIndex: 0,
    },
    {
      file: 'src/pages/index.astro',
      line: 2,
      media: null,
      range: { end: 40, start: 21 },
      scoped: true,
      selector: '.second',
      styleBlockIndex: 0,
    },
  ];
  assert.throws(
    () =>
      joinEffectiveSelectors(records, [
        {
          content: '.second[data-astro-cid-proof] {}\n.first[data-astro-cid-proof] {}',
          id: '/project/src/pages/index.astro?astro&type=style&index=0&lang.css',
          url: '/src/pages/index.astro?astro&type=style&index=0&lang.css',
        },
      ]),
    /AstroProjectAdapter private seam rejection: compiled selector \.second\[data-astro-cid-proof\] does not preserve source selector \.first at rule 0/,
  );
});

test('the Astro source index fails closed when compiler blocks no longer correlate', () => {
  const source = '<style>.source { color: red; }</style>';
  assert.throws(
    () =>
      indexAstroSource('src/pages/index.astro', source, [
        {
          attrs: {},
          content: '.compiled { color: blue; }',
          index: 0,
        },
      ]),
    /AstroProjectAdapter private seam rejection: compiler style block 0 does not match raw style block 0 in src\/pages\/index\.astro/,
  );
});

test('the Astro source index rejects unconsumed compiler blocks', () => {
  const source = '<style>.source { color: red; }</style>';
  assert.throws(
    () =>
      indexAstroSource('src/pages/index.astro', source, [
        { attrs: {}, content: '.source { color: red; }', index: 0 },
        { attrs: {}, content: '.extra { color: blue; }', index: 1 },
      ]),
    /AstroProjectAdapter private seam rejection: 1 compiler style block remained uncorrelated in src\/pages\/index\.astro/,
  );
});

test('the Astro source index preserves compiler-skipped inline blocks as global edit truth', () => {
  const records = indexAstroSource(
    'src/pages/index.astro',
    '<style is:inline>.inline { color: red; }</style><style>.scoped { color: blue; }</style>',
  );

  assert.deepEqual(
    records.map(({ scoped, selector, styleBlockIndex }) => ({
      scoped,
      selector,
      styleBlockIndex,
    })),
    [
      { scoped: false, selector: '.inline', styleBlockIndex: null },
      { scoped: true, selector: '.scoped', styleBlockIndex: 0 },
    ],
  );
});

test('the compiled CSS join rejects a missing module for the active route', () => {
  const records = [
    {
      file: 'src/pages/index.astro',
      line: 1,
      media: null,
      range: { end: 20, start: 0 },
      scoped: true,
      selector: '.active',
      styleBlockIndex: 0,
    },
  ];

  assert.throws(
    () =>
      joinEffectiveSelectors(records, [], {
        requiredScopedFiles: ['src/pages/index.astro'],
      }),
    /AstroProjectAdapter private seam rejection: active route CSS module is absent for src\/pages\/index\.astro style block 0/,
  );
});
