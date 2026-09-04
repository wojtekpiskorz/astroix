import { isPlainRecord } from '../raw/value-partition.ts';
import type { DraftValidation } from '../validation/validate-draft.ts';
import type { DraftBaseline, DraftBinding } from './form-draft-store.ts';

/**
 * The validated edit intent (#252, J2): the object the form slice
 * PRODUCES and never sends — the future J3 write lane's consumed
 * shape, carried today as feature state only (no write endpoint, no
 * optimistic persistence, nothing leaves the document).
 *
 * What the intent carries, per the AC: the entry identity, the
 * INSPECTED REVISION the draft began from (the SHA-256 baseline
 * edit-authority grants bind — the freshness fact a J3 write presents),
 * the SOURCE BASELINE (the inspected truth the draft started from —
 * both values and the body, so the write lane can compute its edit
 * against what was actually inspected), and the validated draft values
 * — which, by the draft store's merge law, still contain every
 * baseline value the draft did not replace (the property tests pin
 * this: untouched source values never drop).
 */

/** The intent object J3's write lane will consume — produced here, never sent. */
export interface ContentEditIntent {
  readonly collection: string;
  readonly entryId: string;
  /** The entry's inspected SHA-256 at draft start — the write baseline's freshness fact; null file-less. */
  readonly revision: string | null;
  /** The source baseline as inspected — the values the draft began from, and the body carried untouched. */
  readonly baseline: { readonly values: unknown; readonly body: string | null };
  /** The validated draft values — the whole document, untouched baseline values included. */
  readonly values: unknown;
}

/** Structural equality over JSON-plain value trees — order-insensitive on records. */
export function plainEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!(key in b) || !plainEquals(a[key], b[key])) return false;
    }
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (const [index, item] of a.entries()) {
      if (!plainEquals(item, b[index])) return false;
    }
    return true;
  }
  return false;
}

/** The intent surface's state vocabulary — what the pane renders. */
export type IntentState = 'none' | 'ready' | 'invalid';

/** The intent derivation input — the draft store's state plus its validation. */
export interface IntentDerivation {
  readonly binding: DraftBinding;
  readonly baseline: DraftBaseline;
  readonly values: unknown;
  readonly validation: DraftValidation;
}

/** Derives the intent surface's state: nothing to write, ready, or blocked by diagnostics. */
export function intentStateOf(derivation: IntentDerivation): IntentState {
  // A standing parse failure blocks FIRST: the raw surface is ahead of
  // the values, so "the values equal the baseline" cannot be trusted
  // as "nothing to write" — the user is mid-edit with no parseable
  // draft to hand J3.
  if (derivation.validation.issues.some((issue) => issue.kind === 'parse')) return 'invalid';
  // an otherwise-unedited draft has nothing to write — 'none', whatever
  // the diagnostics say about the truth around it; validation gates
  // the EDITED draft's intent only
  if (plainEquals(derivation.values, derivation.baseline.values)) return 'none';
  return derivation.validation.clean ? 'ready' : 'invalid';
}

/**
 * Materializes the validated edit intent — null unless the draft is
 * clean AND edited (a clean unedited draft has nothing for J3 to
 * write; the pane reports it as `none`, never as an intent).
 */
export function toEditIntent(derivation: IntentDerivation): ContentEditIntent | null {
  if (intentStateOf(derivation) !== 'ready') return null;
  return {
    collection: derivation.binding.collection,
    entryId: derivation.binding.entryId,
    revision: derivation.baseline.revision,
    baseline: { values: derivation.baseline.values, body: derivation.baseline.body },
    values: derivation.values,
  };
}
