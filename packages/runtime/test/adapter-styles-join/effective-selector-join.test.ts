import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCssIndex } from '@wojciechpiskorz/astroix-core';
import { describe, expect, it } from 'vitest';
import { AdapterError } from '../../astro-project-adapter/adapter-error';
import {
  type CompiledStyleModule,
  joinEffectiveSelectors,
} from '../../astro-project-adapter/styles/join/effective-selector-join';
import { readProjectCssSources } from '../../astro-project-adapter/styles/join/project-css-sources';

/**
 * The styles join's pure correspondence core (#226 focused tests): the
 * attribute and where strategies join from compiler-derived selectors
 * with byte-parity against the frozen css-index corpora (the same
 * reference the E1 certification proved over real installs, #225), and
 * every correspondence disagreement — block presence, rule count, rule
 * order, selector identity, transformed-CSS shape — fails closed as a
 * `seam-rejected` AdapterError in the adapter's `{seam, seamClass,
 * expected, observed}` idiom with structural observed descriptions.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FIXTURE_ROOT = join(REPO_ROOT, 'e2e', 'fixture');
const CORPUS_DIR = join(REPO_ROOT, 'e2e', 'behavior-contracts', 'inspection');

const SEAM_BLOCK = 'styles join block correspondence (static scoped block ↔ compiled module)';
const SEAM_RULES = 'styles join rule correspondence (count, order, selector identity)';
const SEAM_SHAPE = 'styles join compiled CSS rule shape';

interface CorpusRecord {
  readonly selector: string;
  readonly file: string;
  readonly range: { start: number; end: number };
  readonly line: number;
  readonly media: string | null;
  readonly scoped: boolean;
  readonly styleBlockIndex: number | null;
  readonly effectiveSelector: string | null;
}

/** The scope-hash normalizer from the #206 proof: hashes are per-path, not contract identity. */
function normalizeScopeToken(selector: string): string {
  return selector
    .replaceAll(/data-astro-cid-[a-z0-9]+/g, 'data-astro-cid-<scope>')
    .replaceAll(/\.astro-[a-z0-9]+/g, '.astro-<scope>');
}

/** Records as comparable data: scope-normalized, field-sorted (the certification comparator). */
function comparable(records: readonly CorpusRecord[]): unknown[] {
  return records
    .map((record) => ({
      ...record,
      effectiveSelector:
        record.effectiveSelector === null ? null : normalizeScopeToken(record.effectiveSelector),
    }))
    .sort((left, right) =>
      left.file === right.file
        ? left.range.start - right.range.start
        : left.file < right.file
          ? -1
          : 1,
    );
}

/** Synthesizes the compiled module for every joined scoped corpus record, from its frozen effective selector. */
function corpusCompiledModules(corpus: { records: CorpusRecord[] }): CompiledStyleModule[] {
  return corpus.records
    .filter((record) => record.scoped && record.effectiveSelector !== null)
    .map((record) => ({
      id: `/proj/${record.file}?astro&type=style&index=${record.styleBlockIndex}&lang.css`,
      url: `/${record.file}?astro&type=style&index=${record.styleBlockIndex}&lang.css`,
      compiledCss: `${record.effectiveSelector} { color: #1e293b; }`,
    }));
}

async function fixtureJoin(
  compiledModules: readonly CompiledStyleModule[],
  requiredScopedFiles?: readonly string[],
) {
  const staticRecords = buildCssIndex(await readProjectCssSources(FIXTURE_ROOT));
  return joinEffectiveSelectors(staticRecords, compiledModules, { requiredScopedFiles });
}

async function loadCorpus(strategy: 'attribute' | 'where'): Promise<{ records: CorpusRecord[] }> {
  return JSON.parse(await readFile(join(CORPUS_DIR, `css-index.${strategy}.json`), 'utf8')) as {
    records: CorpusRecord[];
  };
}

function expectSeamRejection(probe: () => unknown, seam: string): AdapterError {
  let rejection: unknown;
  try {
    probe();
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(AdapterError);
  const error = rejection as AdapterError;
  expect(error.code).toBe('seam-rejected');
  expect(error.details).toMatchObject({ seam, seamClass: 'fail-closed private' });
  expect(error.message).toContain(`seam rejection at ${seam}`);
  return error;
}

describe('joinEffectiveSelectors (corpus parity, both strategies)', () => {
  it('joins the fixture static index to the frozen attribute-strategy corpus byte for byte', async () => {
    const corpus = await loadCorpus('attribute');
    const joined = await fixtureJoin(corpusCompiledModules(corpus), ['src/pages/index.astro']);
    expect(comparable(joined)).toEqual(comparable(corpus.records));

    const scoped = joined.filter((record) => record.scoped);
    expect(scoped).toHaveLength(1);
    // The compiler-derived attribute form is consumed verbatim, never synthesized.
    expect(scoped[0]?.effectiveSelector).toBe('.hero-title[data-astro-cid-lcdefpme]');
    for (const record of joined) {
      if (!record.scoped) expect(record.effectiveSelector).toBeNull();
    }
  });

  it('joins the fixture static index to the frozen where-strategy corpus byte for byte', async () => {
    const corpus = await loadCorpus('where');
    const joined = await fixtureJoin(corpusCompiledModules(corpus), ['src/pages/index.astro']);
    expect(comparable(joined)).toEqual(comparable(corpus.records));

    const scoped = joined.filter((record) => record.scoped);
    expect(scoped).toHaveLength(1);
    // The configured where form (:where(.astro-*)) is consumed verbatim.
    expect(scoped[0]?.effectiveSelector).toBe('.hero-title:where(.astro-lcdefpme)');
  });
});

const MULTI_SOURCE = `<style>
  .a { color: red; }
  .b { color: blue; }
</style>
<style>
  .c { color: green; }
</style>
<style is:global>
  .g { color: black; }
</style>
<style is:inline>
  .i { color: white; }
</style>
`;

function multiStaticRecords() {
  return buildCssIndex([{ file: 'src/pages/multi.astro', contents: MULTI_SOURCE }]);
}

function multiModules(selectors: readonly string[], blockIndex = 0): CompiledStyleModule {
  return {
    id: `/proj/src/pages/multi.astro?astro&type=style&index=${blockIndex}&lang.css`,
    url: `/src/pages/multi.astro?astro&type=style&index=${blockIndex}&lang.css`,
    compiledCss: selectors.map((selector) => `${selector} { color: red; }`).join('\n'),
  };
}

describe('joinEffectiveSelectors (block, rule, ordering, identity)', () => {
  it('correlates blocks by index and rules by count, order, and selector identity', () => {
    const joined = joinEffectiveSelectors(multiStaticRecords(), [
      multiModules(['.a[data-astro-cid-x]', '.b[data-astro-cid-x]'], 0),
      multiModules(['.c:where(.astro-x)'], 1),
    ]);
    const bySelector = new Map(joined.map((record) => [record.selector, record.effectiveSelector]));
    expect(bySelector.get('.a')).toBe('.a[data-astro-cid-x]');
    expect(bySelector.get('.b')).toBe('.b[data-astro-cid-x]');
    // The configured where form joins from compiler output the same way.
    expect(bySelector.get('.c')).toBe('.c:where(.astro-x)');
    // Global and inline blocks never join, even when a module exists for the file.
    expect(bySelector.get('.g')).toBeNull();
    expect(bySelector.get('.i')).toBeNull();
  });

  it('joins scoped records of a file with no compiled modules as null (not loaded on the route)', () => {
    const joined = joinEffectiveSelectors(multiStaticRecords(), []);
    expect(joined.every((record) => record.effectiveSelector === null)).toBe(true);
  });

  it('reduces compound, descendant, and whitespace-padded compiled selectors to their source form', () => {
    const staticRecords = buildCssIndex([
      {
        file: 'src/pages/compound.astro',
        contents: '<style>.list > li, .list a span { color: red; }</style>',
      },
    ]);
    const joined = joinEffectiveSelectors(staticRecords, [
      {
        id: '/proj/src/pages/compound.astro?astro&type=style&index=0&lang.css',
        url: '/src/pages/compound.astro?astro&type=style&index=0&lang.css',
        compiledCss:
          '.list > li[data-astro-cid-x],\n  .list a span[data-astro-cid-x] { color: red; }',
      },
    ]);
    expect(joined[0]?.effectiveSelector).toBe(
      '.list > li[data-astro-cid-x],\n  .list a span[data-astro-cid-x]',
    );
  });

  it('correlates block 1 without matching block 10 (index boundary)', () => {
    const staticRecords = buildCssIndex([
      { file: 'src/pages/twelve.astro', contents: twelveBlockSource(11) },
    ]);
    const modules = Array.from({ length: 11 }, (_, index) => ({
      id: `/proj/src/pages/twelve.astro?astro&type=style&index=${index}&lang.css`,
      url: `/src/pages/twelve.astro?astro&type=style&index=${index}&lang.css`,
      compiledCss: `.s${index}[data-astro-cid-x] { color: red; }`,
    }));
    const joined = joinEffectiveSelectors(staticRecords, modules);
    expect(joined.filter((record) => record.effectiveSelector !== null)).toHaveLength(11);
  });
});

describe('joinEffectiveSelectors (fail-closed negatives)', () => {
  it('rejects a missing compiled module for the active route component', () => {
    const error = expectSeamRejection(
      () =>
        joinEffectiveSelectors(multiStaticRecords(), [], {
          requiredScopedFiles: ['src/pages/multi.astro'],
        }),
      SEAM_BLOCK,
    );
    expect(error.details).toMatchObject({
      expected: expect.stringContaining('block 0 of src/pages/multi.astro'),
      observed: 'no compiled module for that block in the route CSS set',
    });
  });

  it('rejects a loaded file with an absent block module (partial drift)', () => {
    const error = expectSeamRejection(
      () => joinEffectiveSelectors(multiStaticRecords(), [multiModules(['.c:where(.astro-x)'], 1)]),
      SEAM_BLOCK,
    );
    expect(error.details).toMatchObject({
      expected: expect.stringContaining('the file has compiled modules on this route'),
      observed: expect.stringContaining('no compiled module'),
    });
  });

  it('rejects a rule-count disagreement', () => {
    const error = expectSeamRejection(
      () => joinEffectiveSelectors(multiStaticRecords(), [multiModules(['.a[data-astro-cid-x]'])]),
      SEAM_RULES,
    );
    expect(error.details).toMatchObject({
      expected: '2 compiled rules for block 0 of src/pages/multi.astro (the static rule count)',
      observed: 'a compiled rule count of 1',
    });
  });

  it('rejects reordered rules (order is correspondence, not best-effort matching)', () => {
    expectSeamRejection(
      () =>
        joinEffectiveSelectors(multiStaticRecords(), [
          multiModules(['.b[data-astro-cid-x]', '.a[data-astro-cid-x]']),
        ]),
      SEAM_RULES,
    );
  });

  it('rejects a compiled selector that does not reduce to its source selector', () => {
    const error = expectSeamRejection(
      () =>
        joinEffectiveSelectors(multiStaticRecords(), [
          multiModules(['.x[data-astro-cid-x]', '.b[data-astro-cid-x]']),
        ]),
      SEAM_RULES,
    );
    expect(error.details).toMatchObject({
      expected: expect.stringContaining('compiled rule 0 of block 0'),
      observed: 'a compiled selector that does not reduce to its source selector',
    });
  });

  it('rejects a compiled selector carrying no scope token at all', () => {
    // Unscoped compiled output for a scoped block is a correspondence
    // break even though the bare selector would textually reduce — a
    // joined scoped selector must carry the compiler's token (the frozen
    // corpora's identity invariant).
    const error = expectSeamRejection(
      () => joinEffectiveSelectors(multiStaticRecords(), [multiModules(['.a', '.b'])]),
      SEAM_RULES,
    );
    expect(error.details).toMatchObject({
      observed: 'a compiled selector that carries no scope token for a scoped rule',
    });
  });

  it('rejects unknown transformed-CSS shape (unparseable compiled CSS)', () => {
    const error = expectSeamRejection(
      () =>
        joinEffectiveSelectors(multiStaticRecords(), [
          {
            id: '/proj/src/pages/multi.astro?astro&type=style&index=0&lang.css',
            url: '/src/pages/multi.astro?astro&type=style&index=0&lang.css',
            compiledCss: '.a { color: red;',
          },
        ]),
      SEAM_SHAPE,
    );
    expect(error.details).toMatchObject({
      observed: 'compiled CSS that does not parse as a stylesheet',
    });
    expect(error.cause).toBeInstanceOf(Error);
  });
});

/** Eleven consecutive single-rule scoped blocks — index 0..10, exercising the 1-vs-10 boundary. */
function twelveBlockSource(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `<style>\n.s${index} { color: red; }\n</style>`,
  ).join('\n');
}
