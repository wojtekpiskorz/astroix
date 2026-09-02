import { LIMITS } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import { boundedPage } from '../../api/pagination/page-contract.ts';

/**
 * The F3 bounded page-contract focused legs (#235): the generic page
 * math — page-size ceilings, budget clamping, continuation cursors,
 * completion, and the two honest refusals — pinned as pure behavior
 * over synthetic envelopes. Byte counting is UTF-8 (the protocol's
 * `envelopeBytes` unit): multi-byte content counts honestly against
 * the cap, never by JS string length.
 */

/** A synthetic list envelope: constant overhead plus one JSON object per item. */
function listEnvelopeFor(page: readonly unknown[]): unknown {
  return { protocolVersion: 1, requestId: 'req-1', result: { kind: 'synthetic', items: page } };
}

/** Items of roughly `units` bytes each — deterministic, no shared state. */
function itemsOf(count: number, units: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `${index}:${'x'.repeat(units)}`);
}

describe('whole-collection pages', () => {
  it('carries a small collection whole with a null continuation', () => {
    const items = itemsOf(5, 10);
    const page = boundedPage({
      items,
      offset: 0,
      budget: 'lifecycleJsonBytes',
      envelopeFor: listEnvelopeFor,
    });
    expect(page).toMatchObject({ kind: 'page', items, continuation: null });
    if (page.kind !== 'page') return;
    expect(page.pageBytes).toBeLessThanOrEqual(LIMITS.lifecycleJsonBytes);
  });

  it('answers an offset at or past the end with the empty completing page', () => {
    const page = boundedPage({
      items: itemsOf(3, 10),
      offset: 3,
      budget: 'lifecycleJsonBytes',
      envelopeFor: listEnvelopeFor,
    });
    expect(page).toMatchObject({ kind: 'page', items: [], continuation: null });
    const beyond = boundedPage({
      items: itemsOf(3, 10),
      offset: 100,
      budget: 'lifecycleJsonBytes',
      envelopeFor: listEnvelopeFor,
    });
    expect(beyond).toMatchObject({ kind: 'page', items: [], continuation: null });
  });

  it('clamps a negative offset to the head of the collection', () => {
    const items = itemsOf(4, 10);
    const page = boundedPage({
      items,
      offset: -3,
      budget: 'lifecycleJsonBytes',
      envelopeFor: listEnvelopeFor,
    });
    expect(page).toMatchObject({ kind: 'page', items, continuation: null });
  });
});

describe('page-size ceilings and budget clamping', () => {
  it('honors a requested page size that fits the budget', () => {
    const items = itemsOf(10, 10);
    const page = boundedPage({
      items,
      offset: 0,
      requestedPageSize: 3,
      budget: 'lifecycleJsonBytes',
      envelopeFor: listEnvelopeFor,
    });
    expect(page).toMatchObject({ kind: 'page', continuation: 3 });
    if (page.kind !== 'page') return;
    expect(page.items).toEqual(items.slice(0, 3));
  });

  it('clamps a requested page size that would breach the budget — bounded delivery outranks the hint', () => {
    // Each item ~1024 bytes; the 64 KiB lifecycle budget cannot carry 200 of them.
    const items = itemsOf(200, 1020);
    const page = boundedPage({
      items,
      offset: 0,
      requestedPageSize: 200,
      budget: 'lifecycleJsonBytes',
      envelopeFor: listEnvelopeFor,
    });
    expect(page.kind).toBe('page');
    if (page.kind !== 'page') return;
    expect(page.items.length).toBeLessThan(200);
    expect(page.items.length).toBeGreaterThanOrEqual(1);
    expect(page.pageBytes).toBeLessThanOrEqual(LIMITS.lifecycleJsonBytes);
    expect(page.continuation).toBe(page.items.length);
  });

  it('treats a requested page size of 0 or less as invalid input — the smallest honest page, never "everything"', () => {
    const items = itemsOf(8, 10);
    for (const requestedPageSize of [0, -5]) {
      const page = boundedPage({
        items,
        offset: 0,
        requestedPageSize,
        budget: 'lifecycleJsonBytes',
        envelopeFor: listEnvelopeFor,
      });
      expect(page.kind, `requested ${requestedPageSize}`).toBe('page');
      if (page.kind !== 'page') return;
      // one item carried, the rest continues — the nonsense hint is
      // never widened into the whole available prefix
      expect(page.items, `requested ${requestedPageSize}`).toEqual(items.slice(0, 1));
      expect(page.continuation, `requested ${requestedPageSize}`).toBe(1);
    }
  });

  it('treats a non-finite requested page size (NaN, Infinity) as invalid input — not an empty completed walk', () => {
    const items = itemsOf(8, 10);
    for (const requestedPageSize of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const page = boundedPage({
        items,
        offset: 0,
        requestedPageSize,
        budget: 'lifecycleJsonBytes',
        envelopeFor: listEnvelopeFor,
      });
      expect(page.kind, `requested ${requestedPageSize}`).toBe('page');
      if (page.kind !== 'page') return;
      // the pre-guard failure mode was a zero-item page with a null
      // continuation — the collection silently vanishing behind a
      // "completed" walk; NaN must clamp to one carried item instead
      expect(page.items, `requested ${requestedPageSize}`).toEqual(items.slice(0, 1));
      expect(page.continuation, `requested ${requestedPageSize}`).toBe(1);
    }
  });

  it('paginates a collection that could never fit whole — every page within budget, walk to completion', () => {
    const items = itemsOf(300, 1020);
    const collected: string[] = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const page = boundedPage({
        items,
        offset,
        budget: 'lifecycleJsonBytes',
        envelopeFor: listEnvelopeFor,
      });
      expect(page.kind).toBe('page');
      if (page.kind !== 'page') throw new Error('unreachable');
      expect(page.pageBytes, `page ${pages}`).toBeLessThanOrEqual(LIMITS.lifecycleJsonBytes);
      expect(page.items.length, `page ${pages}`).toBeGreaterThan(0);
      collected.push(...page.items);
      pages += 1;
      if (page.continuation === null) break;
      offset = page.continuation;
    }
    expect(pages).toBeGreaterThan(1);
    expect(collected).toEqual(items);
  });
});

describe('byte honesty', () => {
  it('counts multi-byte UTF-8 content against the budget, not JS string length', () => {
    // 2000 characters of 3-byte code points = 6000 UTF-8 bytes: an
    // envelope budget that admits it by .length would refuse it by bytes.
    const emojiItem = '😀'.repeat(2000);
    const byBytes = boundedPage({
      items: [emojiItem],
      offset: 0,
      budget: 'lifecycleJsonBytes',
      envelopeFor: (page) => ({ padding: page[0] }),
    });
    expect(byBytes.kind).toBe('page');
    if (byBytes.kind !== 'page') return;
    expect(byBytes.pageBytes).toBeGreaterThanOrEqual(6000);
  });

  it('refuses a single item that alone breaches the budget — never silently truncated', () => {
    const page = boundedPage({
      items: ['x'.repeat(LIMITS.lifecycleJsonBytes + 4096)],
      offset: 0,
      budget: 'lifecycleJsonBytes',
      envelopeFor: (page) => ({ padding: page[0] }),
    });
    expect(page).toMatchObject({
      kind: 'refused',
      reason: 'single-item-over-budget',
      limit: 'lifecycleJsonBytes',
    });
    if (page.kind === 'refused') {
      expect(page.receivedBytes).toBeGreaterThan(LIMITS.lifecycleJsonBytes);
    }
  });

  it('refuses an envelope construction whose EMPTY page alone breaches the budget', () => {
    const page = boundedPage({
      items: ['x'],
      offset: 0,
      budget: 'lifecycleJsonBytes',
      envelopeFor: () => ({ padding: 'y'.repeat(LIMITS.lifecycleJsonBytes + 1) }),
    });
    expect(page).toMatchObject({ kind: 'refused', reason: 'empty-envelope-over-budget' });
  });
});
