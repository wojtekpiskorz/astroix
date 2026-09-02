import type { EffectiveSelectorRecord } from '../styles/join/effective-selector-join';

/**
 * The certification corpus comparator (#225; reduced to its certification-
 * owned core at #301): the styles legs join REAL compiler output through
 * the product joiner (`astro-project-adapter/styles/join/**`) and compare
 * the joined records against the frozen inspection corpora
 * (`e2e/behavior-contracts/inspection/css-index.*.json`) — and the two
 * sides are compared as data. Scope hashes are per-path (a temp-copy root
 * hashes differently than the corpus's capture root), so identity is
 * scope-normalized on BOTH sides by this one comparator; record order is
 * walk order, so both sides are field-sorted before equality.
 *
 * The walk/transform/join this file once carried alongside the comparator
 * was the product joiner's pre-#300 copy and is deleted: the suite now
 * certifies exactly what ships. The join itself is the product module's,
 * and the corpora stay the independent oracle — nothing evidentiary was
 * lost by the deletion, everything divergent was.
 */

/** The scope-hash normalizer from the #206 proof: hashes are per-path, not contract identity. */
function normalizeScopeToken(selector: string): string {
  return selector
    .replaceAll(/data-astro-cid-[a-z0-9]+/g, 'data-astro-cid-<scope>')
    .replaceAll(/\.astro-[a-z0-9]+/g, '.astro-<scope>');
}

/** Records as comparable data: scope-normalized, field-sorted. */
export function comparableRecords(records: readonly EffectiveSelectorRecord[]): unknown[] {
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
