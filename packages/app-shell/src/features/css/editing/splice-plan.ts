import type { WritePlan } from '@wojciechpiskorz/astroix-protocol';
import type { BoundStyleRecord } from '../inspection/bind-styles.ts';
import { declarationText, parseRule, selectorHeadBounds } from './declarations.ts';
import type { CssWriteFact } from './write-facts.ts';

/**
 * The CSS vertical's splice planner (#250, I2 — the domain-specific
 * half ADR-0002 amendment 5 walls off inside the feature): composes
 * the wire write plan for one rule edit — a declaration's value or the
 * rule's selector head — over the file's served raw truth and the
 * server-issued opaque css grant. Byte-surgical by proof, never by
 * trust: the planner RE-DERIVES the target slice's exact bounds from
 * the record's range and the raw text, and refuses (writing nothing)
 * unless the raw slice at those bounds is byte-identical to the parsed
 * expectation — a changed source range, a drifted record, or a
 * truncated raw are all the same honest refusal, exactly the frozen
 * contracts' invariants (the bytes outside the splice range survive
 * byte-identical, the replaced slice is the baseline's own).
 *
 * The wire law: the plan carries the OPAQUE grant verbatim (echoed
 * field-for-field, never reinterpreted) and the range as JavaScript
 * string indices into the resource's current contents — the protocol's
 * `sourceRange` species, the same space the frozen corpus and core's
 * splice-writer share. No path is ever submitted: the grant is the
 * only authority the plan carries.
 */

/** The planner's refusal vocabulary — sanitized, the editor's stable conflict reasons. */
export type SplicePlanRefusal =
  | 'no-facts'
  | 'unparseable-rule'
  | 'no-declaration'
  | 'no-selector'
  | 'source-drift'
  | 'no-change';

/** The wire splice plan — the protocol union's splice variant, the only one this feature writes. */
export type SpliceWritePlan = Extract<WritePlan, { readonly operation: 'splice' }>;

/** One planned splice — the wire plan plus the proof's own expectation. */
export interface PlannedSplice {
  readonly plan: SpliceWritePlan;
  /** The bytes the splice replaces — the undo record's inverse anchor. */
  readonly replaced: string;
}

/** The planner's result — the splice, or the named refusal. */
export type SplicePlanResult =
  | { ok: true; splice: PlannedSplice }
  | { ok: false; code: SplicePlanRefusal };

/** The record's rule text — the raw slice at the record's own range, `null` when it cannot be cut. */
function ruleTextOf(raw: string, record: BoundStyleRecord): string | null {
  if (record.range.end > raw.length || record.range.start >= record.range.end) return null;
  return raw.slice(record.range.start, record.range.end);
}

/** The shared proof: the raw slice at [start, end) must be exactly `expected` — else drift. */
function sliceIs(raw: string, start: number, end: number, expected: string): boolean {
  return end <= raw.length && raw.slice(start, end) === expected;
}

/**
 * Plans one declaration-value edit: locates the property's declaration
 * inside the record's rule, composes the replacement through the frozen
 * contract's own serialization species, and proves the raw slice at
 * the declaration's bounds still is the parsed source text. The
 * splice's range is file-absolute (the rule's range start lifted).
 */
export function planDeclarationSplice(input: {
  readonly fact: CssWriteFact;
  readonly record: BoundStyleRecord;
  readonly property: string;
  readonly nextValue: string;
}): SplicePlanResult {
  const { fact, record, property, nextValue } = input;
  const ruleText = ruleTextOf(fact.raw, record);
  if (ruleText === null) return { ok: false, code: 'source-drift' };
  const parsed = parseRule(ruleText);
  if (parsed === null) return { ok: false, code: 'unparseable-rule' };
  const declaration = parsed.declarations.find((candidate) => candidate.property === property);
  if (declaration === undefined) return { ok: false, code: 'no-declaration' };
  const start = record.range.start + declaration.start;
  const end = record.range.start + declaration.end;
  if (!sliceIs(fact.raw, start, end, declaration.text)) return { ok: false, code: 'source-drift' };
  const replacement = declarationText(property, nextValue);
  if (replacement === declaration.text) return { ok: false, code: 'no-change' };
  return {
    ok: true,
    splice: {
      plan: {
        operation: 'splice',
        grant: fact.grant,
        range: { start, end },
        replacement,
      },
      replaced: declaration.text,
    },
  };
}

/**
 * Plans one selector-head rename: locates the rule's selector inside
 * the record's rule text and splices exactly its bounds — the frozen
 * `css-scoped-splice` species (a scoped block's source selector, its
 * compiled effective form following through the project's own
 * recompilation).
 */
export function planSelectorSplice(input: {
  readonly fact: CssWriteFact;
  readonly record: BoundStyleRecord;
  readonly nextSelector: string;
}): SplicePlanResult {
  const { fact, record, nextSelector } = input;
  const ruleText = ruleTextOf(fact.raw, record);
  if (ruleText === null) return { ok: false, code: 'source-drift' };
  const bounds = selectorHeadBounds(ruleText);
  if (bounds === null) return { ok: false, code: 'no-selector' };
  const start = record.range.start + bounds.start;
  const end = record.range.start + bounds.end;
  if (!sliceIs(fact.raw, start, end, record.selector)) return { ok: false, code: 'source-drift' };
  if (record.selector === nextSelector) return { ok: false, code: 'no-change' };
  return {
    ok: true,
    splice: {
      plan: {
        operation: 'splice',
        grant: fact.grant,
        range: { start, end },
        replacement: nextSelector,
      },
      replaced: record.selector,
    },
  };
}

/**
 * The inverse of one landed splice — the undo record's engine: the
 * replacement that restores the replaced bytes, over the range the
 * landed write left them at, carrying the landed replacement through
 * as the byte-proof the undo dispatch re-checks against the live raw
 * before dispatching (the undo planner re-runs the same slice-proof
 * discipline). Pure.
 */
export function invertSplice(splice: {
  readonly range: { readonly start: number; readonly end: number };
  readonly replacement: string;
  readonly replaced: string;
}): {
  range: { start: number; end: number };
  replacement: string;
  replaced: string;
} {
  return {
    range: { start: splice.range.start, end: splice.range.start + splice.replacement.length },
    replacement: splice.replaced,
    replaced: splice.replacement,
  };
}
