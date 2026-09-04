import { describe, expect, it } from 'vitest';
import type { IndexPayloadRecord } from '../../../../../core/src/matcher.ts';
import { inspectionFixture } from '../../../presentation/fixtures.ts';
import { bindStylesInspection, isSanitizedProjectFile } from './bind-styles.ts';
import { isStaleStylesPayload } from './freshness.ts';
import { matchedStyleRows } from './match-rows.ts';

/**
 * The CSS feature's inspection seams (#249's focused units): the
 * fail-closed payload binding (the sanitized-file law above all), the
 * stale-revision decision, and the match-row ordering — pinned against
 * the FROZEN css-index corpora (both scoped-style strategies: the
 * `attribute` corpus's `[data-astro-cid-*]` forms and the `where`
 * corpus's `:where(.astro-*)` forms — the frozen standard the live
 `attribute`-strategy host serves the same shapes of).
 */

const attributeCorpus = inspectionFixture('css-index.attribute.json');
const whereCorpus = inspectionFixture('css-index.where.json');

/** The corpus's records as the wire serves them (the payload the binding consumes). */
function corpusPayload(records: readonly IndexPayloadRecord[]): unknown {
  return { revision: 3, invalidationRevision: 2, records: [...records] };
}

/** One live element shaped like the corpus's selected target (`<h1 class="hero-title" data-astro-cid-…>`). */
function heroTitleElement(scopeAttribute?: string): Element {
  const element = document.createElement('h1');
  element.className = 'hero-title';
  if (scopeAttribute !== undefined) element.setAttribute(scopeAttribute, '');
  return element;
}

describe('the styles payload binding', () => {
  it('binds the frozen attribute-strategy corpus completely — every record, both revisions', () => {
    const bound = bindStylesInspection(corpusPayload(attributeCorpus.records));
    expect(bound).not.toBeNull();
    expect(bound?.revision).toBe(3);
    expect(bound?.invalidationRevision).toBe(2);
    expect(bound?.records.map((record) => record.selector)).toEqual(
      attributeCorpus.records.map((record) => record.selector),
    );
  });

  it('binds the frozen where-strategy corpus verbatim — the :where() effective forms ride unchanged', () => {
    const bound = bindStylesInspection(corpusPayload(whereCorpus.records));
    expect(bound).not.toBeNull();
    const scoped = bound?.records.find((record) => record.scoped);
    expect(scoped?.effectiveSelector).toMatch(/^\.hero-title:where\(\.astro-[a-z0-9]+\)$/);
  });

  it('rejects the drifted interiors — a missing field, a wrong type, a bad revision', () => {
    const record = attributeCorpus.records[0] as IndexPayloadRecord;
    expect(bindStylesInspection(corpusPayload([{ ...record, selector: '' }]))).toBeNull();
    expect(
      bindStylesInspection(corpusPayload([{ ...record, range: { start: 9, end: 3 } }])),
    ).toBeNull();
    expect(bindStylesInspection({ revision: 0, invalidationRevision: 0, records: [] })).toBeNull();
    expect(bindStylesInspection({ revision: 1, records: [] })).toBeNull();
    expect(bindStylesInspection({ revision: 1, invalidationRevision: 0 })).toBeNull();
    // the join's null-when-unloaded truth: a scoped block whose module is
    // not in the observed route's client graph binds with a null
    // effective form — legitimate on any route that does not load it
    const scoped = attributeCorpus.records.find((entry) => entry.scoped) as IndexPayloadRecord;
    expect(
      bindStylesInspection(corpusPayload([{ ...scoped, effectiveSelector: null }])),
    ).not.toBeNull();
  });

  it('enforces the sanitized project-relative file law — the one place a rendering surface can rely on it', () => {
    expect(isSanitizedProjectFile('src/pages/home.css')).toBe(true);
    expect(isSanitizedProjectFile('/abs/pages/home.css')).toBe(false);
    expect(isSanitizedProjectFile('../outside.css')).toBe(false);
    expect(isSanitizedProjectFile('src/../../escape.css')).toBe(false);
    expect(isSanitizedProjectFile('win\\path.css')).toBe(false);
    expect(isSanitizedProjectFile('C:/drive.css')).toBe(false);
    expect(isSanitizedProjectFile('')).toBe(false);
    const record = attributeCorpus.records[0] as IndexPayloadRecord;
    expect(bindStylesInspection(corpusPayload([{ ...record, file: '/etc/passwd' }]))).toBeNull();
    expect(
      bindStylesInspection(corpusPayload([{ ...record, file: 'a/../../etc/passwd' }])),
    ).toBeNull();
  });
});

describe('the stale-revision decision', () => {
  it('rejects only a strictly lower revision on the same route', () => {
    const served = { route: '/', revision: 5 };
    expect(
      isStaleStylesPayload(served, '/', { revision: 4, invalidationRevision: 1, records: [] }),
    ).toBe(true);
    expect(
      isStaleStylesPayload(served, '/', { revision: 5, invalidationRevision: 1, records: [] }),
    ).toBe(false);
    expect(
      isStaleStylesPayload(served, '/', { revision: 6, invalidationRevision: 1, records: [] }),
    ).toBe(false);
    // a different route is its own resource — never compared
    expect(
      isStaleStylesPayload(served, '/blog/x', {
        revision: 1,
        invalidationRevision: 0,
        records: [],
      }),
    ).toBe(false);
    expect(
      isStaleStylesPayload(null, '/', { revision: 1, invalidationRevision: 0, records: [] }),
    ).toBe(false);
  });
});

describe('the match-row ordering', () => {
  it('orders the attribute corpus deterministically: the scoped effective form wins, globals keep payload order', () => {
    const element = heroTitleElement('data-astro-cid-lcdefpme');
    const rows = matchedStyleRows(attributeCorpus.records, element);
    // the four truths of the fixture's .hero-title world: the scoped
    // compiled form (0,2,0) first as the winner, then the three global
    // occurrences (0,1,0) in payload order — two plain, one media-conditioned.
    expect(rows.map((row) => row.record.file)).toEqual([
      'src/pages/index.astro',
      'src/pages/home.css',
      'src/pages/home.css',
      'src/pages/home.css',
    ]);
    expect(rows[0]?.winner).toBe(true);
    expect(rows.slice(1).some((row) => row.winner)).toBe(false);
    expect(rows[0]?.record.effectiveSelector).toBe('.hero-title[data-astro-cid-lcdefpme]');
    expect(rows[3]?.record.media).toBe('(max-width: 640px)');
    // the deterministic order is stable across passes
    expect(matchedStyleRows(attributeCorpus.records, element).map((row) => row.key)).toEqual(
      rows.map((row) => row.key),
    );
  });

  it('matches the where corpus through the same law — :where() contributes zero specificity, payload order breaks the tie', () => {
    // The where strategy's compiled form matches through the astro-*
    // CLASS the compiler emits — a where-strategy canvas document marks
    // its nodes with the class, not the cid attribute.
    const element = heroTitleElement();
    element.classList.add('astro-lcdefpme');
    const rows = matchedStyleRows(whereCorpus.records, element);
    expect(rows).toHaveLength(4);
    // `.hero-title:where(.astro-lcdefpme)` is (0,1,0) — :where() adds
    // nothing — so it TIES the global `.hero-title` occurrences and the
    // matcher's payload-order tie-break governs: the globals (corpus
    // indices 1–3) precede the scoped record (index 6). Deterministic,
    // just a different winner than the attribute strategy's.
    expect(rows.map((row) => row.record.file)).toEqual([
      'src/pages/home.css',
      'src/pages/home.css',
      'src/pages/home.css',
      'src/pages/index.astro',
    ]);
    expect(rows[0]?.winner).toBe(true);
    expect(rows[3]?.record.effectiveSelector).toBe('.hero-title:where(.astro-lcdefpme)');
  });

  it('answers empty for an element nothing styles, and rows carry stable keys across duplicates', () => {
    const unstyled = document.createElement('nav');
    expect(matchedStyleRows(attributeCorpus.records, unstyled)).toHaveLength(0);
    // duplicate source places (the same file+range twice) keep distinct keys
    const duplicate = [
      attributeCorpus.records[0] as IndexPayloadRecord,
      attributeCorpus.records[0] as IndexPayloadRecord,
    ];
    const element = document.createElement('section');
    element.className = 'hero';
    const keys = matchedStyleRows(duplicate, element).map((row) => row.key);
    expect(new Set(keys).size).toBe(2);
  });

  it('skips a scoped record whose module is not in the observed route — the null-effective truth of foreign routes', () => {
    // The blog-route payload shape: every record binds, but the scoped
    // block from the home component carries a null effective form (its
    // module is not in the blog route's client graph) — the element it
    // would style matches nothing through it.
    const scoped = attributeCorpus.records.find((entry) => entry.scoped) as IndexPayloadRecord;
    const unloaded = { ...scoped, effectiveSelector: null };
    const element = heroTitleElement('data-astro-cid-lcdefpme');
    const rows = matchedStyleRows([unloaded], element);
    expect(rows).toHaveLength(0);
  });
});
