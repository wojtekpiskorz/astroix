import type { IndexPayloadRecord } from '../../../../../core/src/matcher.ts';
import { bindCssWriteFacts, type CssWriteFact } from '../editing/write-facts.ts';

/**
 * The styles inspection's fail-closed payload binding (#249, I1; the
 * Content vertical's `api.ts` binder discipline, J1 #251): protocol v1
 * keeps inspection payload interiors opaque (`z.unknown()` — the frozen
 * behavior contracts own the shapes), and the server-side truth is the
 * runtime's converged styles payload (`ConvergedStylesPayload` — the
 * frozen `css-index` family's records plus the two revision stamps).
 * This module binds that opaque interior to the projection the CSS
 * vertical consumes, structurally: one drifted field rejects the whole
 * payload (`null` — the diagnostic state, never a heuristic parse; a
 * seam drift is a compatibility event).
 *
 * Sanitization is binding, not decoration: every record's `file` must
 * be a project-relative posix path (the #370/#376 wire battery's own
 * law — never an absolute path, a traversal, or a backslash), and the
 * binder is the one place a rendering surface can rely on it. Raw
 * module-graph shapes, component paths as selections, and filesystem
 * absolutes never enter the bound shape at all — there is no field for
 * them.
 *
 * The write loop's discovery rides the same payload additively
 * (#250, I2): the `writeFacts` enrichment (per file: the opaque css
 * grant plus the raw text) binds through its own per-fact fail-closed
 * discipline — a drifted fact drops that file's write truth alone,
 * never the read payload, and an absent field is an honestly
 * un-enriched inspection (read-only truth).
 */

/** One bound record — the frozen css-index record shape (the presentation tier's own `RuleRecordView`). */
export type BoundStyleRecord = IndexPayloadRecord;

/** The converged payload as the CSS vertical consumes it — records plus their freshness stamps. */
export interface BoundStylesPayload {
  /** Monotonic styles-resource revision — advances only on published (converged) passes. */
  readonly revision: number;
  /** The invalidation revision this payload converged at — valid until the source advances past it. */
  readonly invalidationRevision: number;
  readonly records: readonly BoundStyleRecord[];
  /** The write loop's per-file facts (#250, I2) — empty when the inspection served un-enriched. */
  readonly writeFacts: ReadonlyMap<string, CssWriteFact>;
}

/** The sanitized project-relative file law: posix, relative, no traversal, no drive, no backslash. */
export function isSanitizedProjectFile(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('../') &&
    !value.includes('/..') &&
    !(value === '..') &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes('//')
  );
}

/** Narrows one unknown to a plain record. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** One nonempty string field. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** One nonnegative integer field. */
function nonnegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** The record's editable source place — the range plus its one-based line. */
interface BoundPlace {
  readonly range: { readonly start: number; readonly end: number };
  readonly line: number;
}

/** Binds the selector and its sanitized project-relative file. */
function bindSelectorAndFile(
  record: Record<string, unknown>,
): { selector: string; file: string } | null {
  const selector = nonEmptyString(record.selector);
  const file = nonEmptyString(record.file);
  if (selector === null || file === null || !isSanitizedProjectFile(file)) return null;
  return { selector, file };
}

/** Binds the record's source place — the byte range and its one-based line. */
function bindPlace(record: Record<string, unknown>): BoundPlace | null {
  const range = asRecord(record.range);
  if (range === null) return null;
  const start = nonnegativeInt(range.start);
  const end = nonnegativeInt(range.end);
  if (start === null || end === null || start > end) return null;
  const line = nonnegativeInt(record.line);
  if (line === null || line < 1) return null;
  return { range: { start, end }, line };
}

/** Binds the record's scope metadata — condition, scopedness, block index, effective form. */
function bindScope(record: Record<string, unknown>): {
  media: string | null;
  scoped: boolean;
  styleBlockIndex: number | null;
  effectiveSelector: string | null;
} | null {
  const media = record.media;
  if (typeof media !== 'string' && media !== null) return null;
  if (typeof record.scoped !== 'boolean') return null;
  const styleBlockIndex =
    record.styleBlockIndex === null ? null : nonnegativeInt(record.styleBlockIndex);
  if (record.styleBlockIndex !== null && styleBlockIndex === null) return null;
  const effectiveSelector =
    record.effectiveSelector === null ? null : nonEmptyString(record.effectiveSelector);
  if (record.effectiveSelector !== null && effectiveSelector === null) return null;
  // `effectiveSelector` is the join's own null-when-unloaded truth (the
  // frozen contract's semantics): null for every global rule, and null
  // for a scoped block whose module is not in the OBSERVED route's
  // client graph — a legitimate payload on any route that does not load
  // the block, never drift. The matcher skips such records (a scoped
  // rule without its compiled form matches nothing there).
  return {
    media,
    scoped: record.scoped,
    styleBlockIndex,
    effectiveSelector,
  };
}

/** Binds one record — every field structural, `null` on any drift. */
function bindRecord(value: unknown): BoundStyleRecord | null {
  const record = asRecord(value);
  if (record === null) return null;
  const identity = bindSelectorAndFile(record);
  const place = bindPlace(record);
  const scope = bindScope(record);
  if (identity === null || place === null || scope === null) return null;
  return { ...identity, ...place, ...scope };
}

/**
 * Binds one opaque styles-inspection payload to the CSS vertical's
 * projection — `null` on any drift (fail closed, never a heuristic
 * parse). Validates the two revision stamps and every record's full
 * key set, including the sanitized-file law.
 */
export function bindStylesInspection(payload: unknown): BoundStylesPayload | null {
  const record = asRecord(payload);
  if (record === null) return null;
  const revision = nonnegativeInt(record.revision);
  const invalidationRevision = nonnegativeInt(record.invalidationRevision);
  if (revision === null || revision < 1 || invalidationRevision === null) return null;
  if (!Array.isArray(record.records)) return null;
  const records: BoundStyleRecord[] = [];
  for (const candidate of record.records) {
    const bound = bindRecord(candidate);
    if (bound === null) return null;
    records.push(bound);
  }
  return { revision, invalidationRevision, records, writeFacts: bindCssWriteFacts(payload) };
}
