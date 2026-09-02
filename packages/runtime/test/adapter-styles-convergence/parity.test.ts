import { buildCssIndex, type CssRuleRecord, type SourceFile } from '@wojciechpiskorz/astroix-core';
import { describe, expect, it } from 'vitest';
import { AdapterError } from '../../astro-project-adapter/adapter-error';
import {
  type StylesMismatch,
  verifyJoinedPayload,
  verifyStylesParity,
} from '../../astro-project-adapter/styles/convergence/parity';
import type { CompiledStyleModule } from '../../astro-project-adapter/styles/join/effective-selector-join';
import { joinEffectiveSelectors } from '../../astro-project-adapter/styles/join/effective-selector-join';

/**
 * The parity classifier's own contract (#227): the five mismatch
 * categories classify precisely from the two observations — the static
 * index (disk truth) and the compiled scoped-style modules (transformed
 * graph truth) — and the joined payload can never downgrade against the
 * parity it was built from. Pure functions over in-memory sources; the
 * composition that gathers the observations is the inspection tests'
 * truth.
 */

const ROUTE_FILE = 'src/pages/index.astro';
const CID = '[data-astro-cid-x1y2z3]';

/** An .astro source whose style block carries the given rules. */
function astroSource(rules: readonly string[]): SourceFile {
  return {
    file: ROUTE_FILE,
    contents: [
      '---',
      '---',
      '<section>fixture</section>',
      '<style>',
      ...rules.map((rule) => `  ${rule} { color: red; }`),
      '</style>',
    ].join('\n'),
  };
}

/** A second .astro file (not the active route) with its own style blocks. */
function componentSource(file: string, rules: readonly string[]): SourceFile {
  return {
    file,
    contents: [
      '<section>component</section>',
      '<style>',
      ...rules.map((rule) => `  ${rule} { color: red; }`),
      '</style>',
    ].join('\n'),
  };
}

function staticRecords(sources: readonly SourceFile[]): CssRuleRecord[] {
  return buildCssIndex([...sources]);
}

/** A compiled module for one block of one file, carrying CSS built rule-by-rule. */
function moduleOf(
  file: string,
  blockIndex: number,
  selectors: readonly string[],
): CompiledStyleModule {
  return {
    id: `/abs/proj/${file}?astro&type=style&index=${blockIndex}&lang.css`,
    url: `/${file}?astro&type=style&index=${blockIndex}&lang.css`,
    compiledCss: selectors.map((selector) => `${selector} { color: red; }`).join('\n'),
  };
}

/** The attribute-strategy compiled form of one selector. */
function scoped(selector: string): string {
  return `${selector}${CID}`;
}

function mismatchOf(
  records: readonly CssRuleRecord[],
  modules: readonly CompiledStyleModule[],
  options?: { readonly requiredScopedFiles?: readonly string[] },
): StylesMismatch | null {
  return verifyStylesParity(records, modules, options);
}

describe('verifyStylesParity', () => {
  it('passes when the compiled selectors reduce to the source sequence', () => {
    const records = staticRecords([astroSource(['.alpha', '.beta'])]);
    expect(
      mismatchOf(records, [moduleOf(ROUTE_FILE, 0, [scoped('.alpha'), scoped('.beta')])]),
    ).toBeNull();
  });

  it('passes for a scoped block that is simply not loaded on the route', () => {
    // Not required, no module for the file at all — the null join shape.
    const records = staticRecords([componentSource('src/components/c.astro', ['.alpha'])]);
    expect(mismatchOf(records, [])).toBeNull();
  });

  it('classifies a missing required block as module-presence', () => {
    const records = staticRecords([astroSource(['.alpha'])]);
    const mismatch = mismatchOf(records, [], { requiredScopedFiles: [ROUTE_FILE] });
    expect(mismatch).toMatchObject({
      category: 'module-presence',
      block: { file: ROUTE_FILE, blockIndex: 0 },
    });
  });

  it('classifies a partially loaded file as module-presence (some blocks compiled, one not)', () => {
    const twoBlocks = [
      '---',
      '---',
      '<section>fixture</section>',
      '<style>',
      '  .alpha { color: red; }',
      '</style>',
      '<style>',
      '  .beta { color: red; }',
      '</style>',
    ].join('\n');
    const records = buildCssIndex([{ file: ROUTE_FILE, contents: twoBlocks }]);
    // Only block 0 has a compiled module; a file with compiled modules on
    // the route must have them all — absence is presence, never a null join.
    const mismatch = mismatchOf(records, [moduleOf(ROUTE_FILE, 0, [scoped('.alpha')])]);
    expect(mismatch).toMatchObject({
      category: 'module-presence',
      block: { file: ROUTE_FILE, blockIndex: 1 },
    });
  });

  it('classifies a compiled rule count disagreement as rule-count', () => {
    const records = staticRecords([astroSource(['.alpha'])]);
    const mismatch = mismatchOf(records, [
      moduleOf(ROUTE_FILE, 0, [scoped('.alpha'), scoped('.beta')]),
    ]);
    expect(mismatch).toMatchObject({
      category: 'rule-count',
      expected: '1 compiled rules for block 0 of src/pages/index.astro (the static rule count)',
      observed: 'a compiled rule count of 2',
    });
  });

  it('classifies the same selectors in a different order as order (no truth advanced)', () => {
    const records = staticRecords([astroSource(['.alpha', '.beta'])]);
    const mismatch = mismatchOf(records, [
      moduleOf(ROUTE_FILE, 0, [scoped('.beta'), scoped('.alpha')]),
    ]);
    expect(mismatch).toMatchObject({
      category: 'order',
      observed: 'the same selectors in a different order on the two sides',
    });
  });

  it('classifies a compiled selector with no source counterpart as selector-identity', () => {
    const records = staticRecords([astroSource(['.alpha'])]);
    const mismatch = mismatchOf(records, [moduleOf(ROUTE_FILE, 0, [scoped('.renamed')])]);
    expect(mismatch).toMatchObject({
      category: 'selector-identity',
      observed:
        'a compiled selector with no source counterpart (one truth advanced past the other)',
    });
  });

  it('classifies a scopeless compiled selector as compiler-source', () => {
    const records = staticRecords([astroSource(['.alpha'])]);
    const mismatch = mismatchOf(records, [moduleOf(ROUTE_FILE, 0, ['.alpha'])]);
    expect(mismatch).toMatchObject({
      category: 'compiler-source',
      expected:
        "compiled rule 0 of block 0 of src/pages/index.astro to carry the compiler's scope token",
      observed: 'a compiled selector that carries no scope token for a scoped rule',
    });
  });

  it('classifies unparseable compiled CSS as compiler-source', () => {
    const records = staticRecords([astroSource(['.alpha'])]);
    const broken = {
      ...moduleOf(ROUTE_FILE, 0, [scoped('.alpha')]),
      compiledCss: `${scoped('.alpha')} { color: red;`,
    };
    const mismatch = mismatchOf(records, [broken]);
    expect(mismatch).toMatchObject({
      category: 'compiler-source',
      observed: 'compiled CSS that does not parse as a stylesheet',
    });
  });

  it('reports the first mismatch in source order, block by block', () => {
    const records = staticRecords([astroSource(['.alpha'])]);
    const firstBlockMissing = mismatchOf(records, [], { requiredScopedFiles: [ROUTE_FILE] });
    expect(firstBlockMissing?.block?.blockIndex).toBe(0);
  });
});

describe('verifyJoinedPayload', () => {
  function joinedFixture(): {
    readonly records: CssRuleRecord[];
    readonly modules: readonly CompiledStyleModule[];
    readonly joined: ReturnType<typeof joinEffectiveSelectors>;
  } {
    const records = staticRecords([
      astroSource(['.alpha']),
      componentSource('src/components/c.astro', ['.gamma']),
    ]);
    const modules = [moduleOf(ROUTE_FILE, 0, [scoped('.alpha')])];
    return {
      records,
      modules,
      joined: joinEffectiveSelectors(records, modules, { requiredScopedFiles: [ROUTE_FILE] }),
    };
  }

  it('accepts a payload that extends the static index exactly', () => {
    const { records, modules, joined } = joinedFixture();
    expect(() => verifyJoinedPayload(records, modules, joined)).not.toThrow();
  });

  it('rejects a dropped record', () => {
    const { records, modules, joined } = joinedFixture();
    expect(() => verifyJoinedPayload(records, modules, joined.slice(1))).toThrow(AdapterError);
  });

  it('rejects a mutated source range', () => {
    const { records, modules, joined } = joinedFixture();
    const downgraded = joined.map((record, index) =>
      index === 0
        ? { ...record, range: { start: record.range.start + 1, end: record.range.end } }
        : record,
    );
    expect(() => verifyJoinedPayload(records, modules, downgraded)).toThrow(AdapterError);
  });

  it('rejects a null effective selector where parity proved a compiled module', () => {
    const { records, modules, joined } = joinedFixture();
    const downgraded = joined.map((record) =>
      record.file === ROUTE_FILE ? { ...record, effectiveSelector: null } : record,
    );
    const rejection = payloadRejection(records, modules, downgraded);
    expect(rejection.details).toMatchObject({
      seam: 'styles convergence payload correspondence (joined records ↔ static index parity)',
      expected: expect.stringContaining('compiler-derived effective selector'),
    });
  });

  it('rejects an unscoped effective selector where parity proved a compiled module', () => {
    const { records, modules, joined } = joinedFixture();
    const downgraded = joined.map((record) =>
      record.file === ROUTE_FILE ? { ...record, effectiveSelector: record.selector } : record,
    );
    expect(() => verifyJoinedPayload(records, modules, downgraded)).toThrow(AdapterError);
  });

  it('rejects a synthesized effective selector where no compiled module exists', () => {
    const { records, modules, joined } = joinedFixture();
    const synthesized = joined.map((record) =>
      record.file === 'src/components/c.astro'
        ? { ...record, effectiveSelector: scoped(record.selector) }
        : record,
    );
    const rejection = payloadRejection(records, modules, synthesized);
    expect(rejection.details).toMatchObject({
      expected: expect.stringContaining('a null effective selector'),
    });
  });
});

function payloadRejection(
  records: readonly CssRuleRecord[],
  modules: readonly CompiledStyleModule[],
  joined: readonly ReturnType<typeof joinEffectiveSelectors>[number][],
): AdapterError {
  try {
    verifyJoinedPayload(records, modules, joined);
  } catch (error) {
    if (error instanceof AdapterError) return error;
    throw new Error(`expected an AdapterError, observed ${String(error)}`);
  }
  throw new Error('expected the payload verification to reject');
}
