import { describe, expect, it } from 'vitest';
import { spliceText } from '../../../../../core/src/splice-writer.ts';
import { editFixture } from '../../../presentation/fixtures.ts';
import type { BoundStyleRecord } from '../inspection/bind-styles.ts';
import { invertSplice, planDeclarationSplice, planSelectorSplice } from './splice-plan.ts';
import type { CssWriteFact } from './write-facts.ts';

/**
 * The splice planner's frozen-contract tier (#250's focused tests): the
 * planner's output is pinned BYTE-EXACT against the frozen edit corpus
 * — the `css-splice` fixture (a declaration value inside a global
 * rule) and the `css-scoped-splice` fixture (a selector rename inside
 * a scoped `<style>` block) — with the output bytes derived through
 * the SAME pure oracle the corpus was captured against (core's
 * splice-writer). A planner result that drifts from the corpus is a
 * defect, not a diff; the negatives pin the refusals (changed source
 * range, drifted raw, out-of-bounds record, no-change) as no-write
 * answers.
 *
 * Record alignment law the fixtures carry: `css-splice.json` freezes
 * only the POST-write index (`indexAfter`) — its ranges are aligned to
 * the AFTER bytes. The pre-write record the planner consumes is the
 * edited rule's own record with the one-byte shift the fixture's edit
 * (+1 char) implies reverted; `css-scoped-splice.json` freezes its
 * pre-write record directly (`indexBefore`). Both alignments are
 * asserted here before the planner legs run, so a corpus change that
 * broke the alignment fails loudly, not as a planner drift.
 */

/** The global splice fixture — baseline, edit, after, and the edited file's post-write records. */
const cssSplice = editFixture('css-splice.json');

/** The scoped splice fixture — baseline, the scoped record before/after, edit, after. */
const cssScoped = editFixture('css-scoped-splice.json');

/** The baseline's byte length delta the fixture's edit implies (`3rem` → `3.5rem`). */
const SPLICE_DELTA = cssSplice.edit.replacement.length - cssSplice.edit.replaced.length;

/** One fact fixture over a corpus baseline — the grant claim the planner echoes. */
function factOver(contents: string, file: string, hash: string): CssWriteFact {
  return {
    file,
    grant: {
      token: 'a'.repeat(48),
      kind: 'css',
      operations: ['replace-contents', 'splice'],
      displayPath: file,
      baseline: { type: 'sha256', sha256: hash },
    },
    raw: contents,
  };
}

/** The edited rule's PRE-write record — the post-write record with the edit's delta reverted. */
function preWriteRecord(): BoundStyleRecord {
  const after = cssSplice.indexAfter.find(
    (record) => record.selector === '.hero-title' && record.media === null,
  );
  if (after === undefined) throw new Error('the fixture lost the edited rule');
  return {
    ...after,
    range: { start: after.range.start, end: after.range.end - SPLICE_DELTA },
  } as BoundStyleRecord;
}

describe('the fixture alignment the planner legs stand on', () => {
  it('the pre-write record slices the baseline at the frozen splice range\u2019s rule', () => {
    const record = preWriteRecord();
    const ruleText = cssSplice.baseline.contents.slice(record.range.start, record.range.end);
    // the rule opens at the selector and CONTAINS the frozen splice range
    expect(ruleText.startsWith('.hero-title')).toBe(true);
    expect(record.range.start).toBeLessThanOrEqual(cssSplice.edit.range.start);
    expect(record.range.end).toBeGreaterThanOrEqual(cssSplice.edit.range.end);
    // the scoped fixture's pre-write record is direct
    expect(cssScoped.baseline.contents.startsWith('---')).toBe(true);
  });
});

describe('the declaration splice — frozen css-splice contract', () => {
  const record = preWriteRecord();
  const fact = factOver(cssSplice.baseline.contents, cssSplice.file, cssSplice.baseline.hash);

  it('plans exactly the frozen range and replacement bytes', () => {
    const planned = planDeclarationSplice({
      fact,
      record,
      property: 'font-size',
      nextValue: '3.5rem',
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    // the frozen request's exact bytes: the declaration's own range and text
    expect(planned.splice.plan.range).toEqual(cssSplice.edit.range);
    expect(planned.splice.plan.replacement).toBe(cssSplice.edit.replacement);
    expect(planned.splice.replaced).toBe(cssSplice.edit.replaced);
    // the wire law: the operation and the echoed opaque grant
    expect(planned.splice.plan.operation).toBe('splice');
    expect(planned.splice.plan.grant).toBe(fact.grant);
  });

  it('produces byte-exact output through the corpus oracle', () => {
    const planned = planDeclarationSplice({
      fact,
      record,
      property: 'font-size',
      nextValue: '3.5rem',
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const after = spliceText(cssSplice.baseline.contents, {
      start: planned.splice.plan.range.start,
      end: planned.splice.plan.range.end,
      replacement: planned.splice.plan.replacement,
    });
    expect(after).toBe(cssSplice.after.contents);
    // the untouched-bytes invariant: everything outside the splice survives
    expect(after.slice(0, cssSplice.edit.range.start)).toBe(
      cssSplice.baseline.contents.slice(0, cssSplice.edit.range.start),
    );
    expect(after.slice(cssSplice.edit.range.start + cssSplice.edit.replacement.length)).toBe(
      cssSplice.baseline.contents.slice(cssSplice.edit.range.end),
    );
  });

  it('plans the media-conditioned occurrence too — the at-rule record over-cover tolerated', () => {
    // the fixture's media record (post-write aligned): revert the
    // delta and edit ITS font-size — the parser closes the body at the
    // rule's own brace, never the at-rule's
    const after = cssSplice.indexAfter.find((record) => record.media === '(max-width: 640px)');
    if (after === undefined) throw new Error('the fixture lost the media rule');
    const mediaRecord = {
      ...after,
      range: { start: after.range.start - SPLICE_DELTA, end: after.range.end - SPLICE_DELTA },
    } as BoundStyleRecord;
    const planned = planDeclarationSplice({
      fact,
      record: mediaRecord,
      property: 'font-size',
      nextValue: '2.5rem',
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const written = spliceText(cssSplice.baseline.contents, {
      start: planned.splice.plan.range.start,
      end: planned.splice.plan.range.end,
      replacement: planned.splice.plan.replacement,
    });
    expect(written).toContain('font-size: 2.5rem;');
    expect(written.slice(0, planned.splice.plan.range.start)).toBe(
      cssSplice.baseline.contents.slice(0, planned.splice.plan.range.start),
    );
  });

  it('refuses an unchanged value — nothing to write', () => {
    const planned = planDeclarationSplice({
      fact,
      record,
      property: 'font-size',
      nextValue: '3rem',
    });
    expect(planned).toEqual({ ok: false, code: 'no-change' });
  });

  it('refuses a property the rule does not carry', () => {
    const planned = planDeclarationSplice({
      fact,
      record,
      property: 'grid-template',
      nextValue: 'none',
    });
    expect(planned).toEqual({ ok: false, code: 'no-declaration' });
  });

  it('refuses a changed source range — a record that no longer slices its rule', () => {
    // A record whose range points INTO the declarations (the corpus's
    // own shifted-after-interference shape) parses no selector head —
    // the honest refusal, writing nothing. Note the planner DOES
    // tolerate a uniformly shifted-but-intact slice (bounds re-derive
    // from the text); the within-rule truth is the server's SHA
    // baseline, never a client guess.
    const planned = planDeclarationSplice({
      fact,
      record: { ...record, range: { start: cssSplice.edit.range.start, end: record.range.end } },
      property: 'font-size',
      nextValue: '3.5rem',
    });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(['source-drift', 'unparseable-rule']).toContain(planned.code);
  });

  it('refuses a drifted selector record — the slice no longer opens at the selector', () => {
    const planned = planSelectorSplice({
      fact,
      record: { ...record, range: { start: record.range.start + 1, end: record.range.end + 1 } },
      nextSelector: '.hero-headline',
    });
    expect(planned).toEqual({ ok: false, code: 'source-drift' });
  });

  it('refuses a record whose range exceeds the raw — the truncated truth', () => {
    const planned = planDeclarationSplice({
      fact: factOver('}.short{}', cssSplice.file, 'b'.repeat(64)),
      record,
      property: 'font-size',
      nextValue: '3.5rem',
    });
    expect(planned).toEqual({ ok: false, code: 'source-drift' });
  });
});

describe('the selector splice — frozen css-scoped-splice contract', () => {
  const record = cssScoped.indexBefore as unknown as BoundStyleRecord;
  const fact = factOver(cssScoped.baseline.contents, cssScoped.file, cssScoped.baseline.hash);

  it('plans exactly the frozen range and replacement bytes', () => {
    const planned = planSelectorSplice({
      fact,
      record,
      nextSelector: '.hero-headline',
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.splice.plan.range).toEqual(cssScoped.edit.range);
    expect(planned.splice.plan.replacement).toBe(cssScoped.edit.replacement);
    expect(planned.splice.replaced).toBe(cssScoped.edit.replaced);
  });

  it('produces byte-exact output through the corpus oracle', () => {
    const planned = planSelectorSplice({
      fact,
      record,
      nextSelector: '.hero-headline',
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const after = spliceText(cssScoped.baseline.contents, {
      start: planned.splice.plan.range.start,
      end: planned.splice.plan.range.end,
      replacement: planned.splice.plan.replacement,
    });
    expect(after).toBe(cssScoped.after.contents);
  });

  it('refuses an unchanged selector', () => {
    const planned = planSelectorSplice({ fact, record, nextSelector: '.hero-title' });
    expect(planned).toEqual({ ok: false, code: 'no-change' });
  });
});

describe('the splice inverse — the undo engine', () => {
  const record = preWriteRecord();
  const fact = factOver(cssSplice.baseline.contents, cssSplice.file, cssSplice.baseline.hash);

  it('inverts a landed splice onto the bytes it left', () => {
    const planned = planDeclarationSplice({
      fact,
      record,
      property: 'font-size',
      nextValue: '3.5rem',
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const landed = spliceText(cssSplice.baseline.contents, {
      start: planned.splice.plan.range.start,
      end: planned.splice.plan.range.end,
      replacement: planned.splice.plan.replacement,
    });
    const inverse = invertSplice({
      range: planned.splice.plan.range,
      replacement: planned.splice.plan.replacement,
      replaced: planned.splice.replaced,
    });
    // the inverse over the landed bytes restores the baseline byte-exactly
    expect(spliceText(landed, { ...inverse.range, replacement: inverse.replacement })).toBe(
      cssSplice.baseline.contents,
    );
  });
});
