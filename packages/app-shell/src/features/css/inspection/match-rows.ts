import { matchRules } from '../../../../../core/src/matcher.ts';
import type { BoundStyleRecord } from './bind-styles.ts';

/**
 * The selection's positioned match rows (#249, I1): the pure editing
 * domain's own matcher (`packages/core` `matchRules` — the frozen
 * integration-era law, retained) over the bound converged records
 * against the LIVE canvas element. Scoped rules match in their compiled
 * effective form and globals in their source form (the matcher's own
 * `matchingSelector` law); the result is sorted by specificity with
 * ties keeping payload order and the cascade winner marked — the
 * deterministic match order the AC names, produced by the same code the
 * frozen contracts were captured against, never a feature-local fork.
 *
 * `Element.matches` runs in the canvas document's realm (the element
 * comes from the disclosed canvas seam), and an unparseable selector is
 * the matcher's own guarded non-match.
 */

/** One matched rule positioned in the cascade — the read-only list's row model. */
export interface MatchedStyleRow {
  readonly record: BoundStyleRecord;
  /** The cascade winner (the specificity sort's head) — exactly one per nonempty list. */
  readonly winner: boolean;
  /** The row's stable identity: the record's editable source place (file + range). */
  readonly key: string;
}

/** The row identity — one rule's source place plus its duplicate occurrence. */
function styleRowKey(base: string, occurrence: number): string {
  return `${base}#${occurrence}`;
}

/**
 * Derives the ordered rows: the core matcher over every bound record,
 * keyed stably for rendering. Empty when nothing matches — the honest
 * "no matching rules" state, distinguished from a missing element by
 * the caller.
 */
export function matchedStyleRows(
  records: readonly BoundStyleRecord[],
  element: Element,
): readonly MatchedStyleRow[] {
  const matched = matchRules([...records], element);
  const seen = new Map<string, number>();
  return matched.map((match) => {
    const base = `${match.record.file}#${match.record.range.start}-${match.record.range.end}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return {
      record: match.record,
      winner: match.winner,
      key: styleRowKey(base, occurrence),
    };
  });
}
