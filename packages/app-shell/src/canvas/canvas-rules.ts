import type { RuntimeRuleSelector } from '../state/selection.ts';

/**
 * The canvas's runtime rule selectors (#242, G3): the effective
 * selectors as the live canvas document itself carries them — read from
 * the document's own stylesheets through the CSSOM, never synthesized.
 * In dev these are exactly the compiled forms the page serves (the
 * scoped `[data-astro-cid-*]` attribute forms verbatim, the configured
 * `:where(...)` forms when a project uses them), which is the same
 * effective-selector truth the adapter's styles join publishes
 * server-side; the CSS vertical's index payload joins its repo rules
 * onto this matching law, and this enumeration is the canvas-side leg
 * that stands alone today.
 *
 * Fail-closed by construction: a stylesheet that cannot be read (a
 * cross-origin sheet throws on `cssRules`) is skipped, never guessed;
 * a rule that is not a style rule or a known grouping is ignored; the
 * walk is bounded so a pathological document cannot stall the panel.
 */

/** The hard bound on enumerated selectors — far past any honest dev page, small enough to never stall the panel. */
export const RUNTIME_SELECTOR_BOUND = 20_000;

/** The stylesheet slice the walk reads — anything exposing `cssRules` (a `CSSStyleSheet` in every real document). */
export interface StyleSheetLike {
  readonly cssRules: CSSRuleList | null;
}

/** One grouping rule — a media/supports/layer block (or an import) carrying nested rules. */
interface GroupingRuleLike extends CSSRule {
  readonly cssRules: CSSRuleList;
}

/** Enumerates the runtime effective selectors of the given sheets, in document order, under the bound. */
export function runtimeRuleSelectors(
  sheets: readonly StyleSheetLike[],
  bound: number = RUNTIME_SELECTOR_BOUND,
): readonly RuntimeRuleSelector[] {
  const selectors: RuntimeRuleSelector[] = [];
  for (const sheet of sheets) {
    collectRules(rulesOf(sheet), null, selectors, bound);
  }
  return selectors;
}

/** One guarded `cssRules` read — an unreadable (cross-origin) sheet is an empty walk, never a crash. */
function rulesOf(sheet: StyleSheetLike): readonly CSSRule[] {
  try {
    return sheet.cssRules === null ? [] : listRules(sheet.cssRules);
  } catch {
    return [];
  }
}

/** Copies one rule list by index — a CSSRuleList is array-like, not reliably iterable (or even `item()`-bearing) across engines. */
function listRules(rules: CSSRuleList): CSSRule[] {
  const copy: CSSRule[] = [];
  for (let index = 0; index < rules.length; index += 1) {
    copy.push(rules[index] as CSSRule);
  }
  return copy;
}

/** Walks one rule list, descending groupings and collecting style rules. */
function collectRules(
  rules: readonly CSSRule[],
  media: string | null,
  out: RuntimeRuleSelector[],
  bound: number,
): void {
  for (const rule of rules) {
    if (out.length >= bound) return;
    collectRule(rule, media, out, bound);
  }
}

/** One rule: a style rule is collected; a media/supports/layer grouping descends (media conditions compose outermost-first); anything else is ignored. */
function collectRule(
  rule: CSSRule,
  media: string | null,
  out: RuntimeRuleSelector[],
  bound: number,
): void {
  // The style-rule check comes FIRST: some engines expose an inherited
  // (empty) `cssRules` on style rules, so the grouping duck-type below
  // must never see one.
  if (rule instanceof CSSStyleRule) {
    out.push({ selector: rule.selectorText, media });
    return;
  }
  if (isGrouping(rule)) {
    const nestedMedia = rule instanceof CSSMediaRule ? rule.conditionText : media;
    collectRules(listRules(rule.cssRules), nestedMedia, out, bound);
  }
}

/** A rule carrying nested rules — the grouping forms the walk descends. */
function isGrouping(rule: CSSRule): rule is GroupingRuleLike {
  return 'cssRules' in rule && rule.cssRules !== null;
}
