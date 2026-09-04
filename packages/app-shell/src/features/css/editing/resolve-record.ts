import type { BoundStyleRecord } from '../inspection/bind-styles.ts';

/**
 * The CSS write loop's record re-resolution (#250, I2): an edit intent
 * carries its target's SEMANTIC identity — file, selector, media, and
 * the range start it was scheduled against — never a frozen record
 * object, because every landed write shifts the ranges of everything
 * after it in the same file and the fresh payload's records are the
 * only current truth. This pure resolver finds the intent's record in
 * whatever payload is live: the same file/selector/media, the range
 * start NEAREST the intent's hint (a file may carry several identical
 * selectors — the fixture's doubly-written `.hero-title` is the
 * corpus's own multi-occurrence case — and the nearest range is the
 * one the user was editing).
 */

/** The semantic identity an edit intent addresses. */
export interface RecordIdentity {
  readonly file: string;
  readonly selector: string;
  readonly media: string | null;
  /** The range start the intent was scheduled against — the disambiguation hint. */
  readonly rangeStart: number;
}

/** The record's own identity — the intent addressing shape. */
export function recordIdentityOf(record: BoundStyleRecord): RecordIdentity {
  return {
    file: record.file,
    selector: record.selector,
    media: record.media,
    rangeStart: record.range.start,
  };
}

/**
 * Resolves one identity against the live records — `null` when no
 * record matches (the file's truth moved past the intent: a reload,
 * not a guess).
 */
export function resolveRecord(
  records: readonly BoundStyleRecord[],
  identity: RecordIdentity,
): BoundStyleRecord | null {
  let best: BoundStyleRecord | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const record of records) {
    if (record.file !== identity.file || record.selector !== identity.selector) continue;
    if (record.media !== identity.media) continue;
    const distance = Math.abs(record.range.start - identity.rangeStart);
    if (distance < bestDistance) {
      best = record;
      bestDistance = distance;
    }
  }
  return best;
}
