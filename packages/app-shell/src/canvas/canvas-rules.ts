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
 * Every rule test is STRUCTURAL, never `instanceof`: the canvas
 * document lives in its own realm, so a parent-realm `instanceof` is
 * false for every canvas rule — a real browser would collect nothing.
 * A rule carrying `selectorText` is collected; a rule carrying
 * `cssRules` is descended (a media rule's `conditionText` + `media`
 * pair is the one distinction the walk makes, carried as the condition
 * badge); everything else is ignored.
 *
 * Fail-closed by construction: a stylesheet that cannot be read (a
 * cross-origin sheet throws on `cssRules`) is skipped, never guessed;
 * the walk is bounded so a pathological document cannot stall the panel.
 */

/** The hard bound on enumerated selectors — far past any honest dev page, small enough to never stall the panel. */
export const RUNTIME_SELECTOR_BOUND = 20_000;

/** The stylesheet slice the walk reads — anything exposing `cssRules` (a `CSSStyleSheet` in every real document). */
export interface StyleSheetLike {
  readonly cssRules: CSSRuleList | null;
}

/** One grouping rule — anything carrying nested rules (media, supports, layer blocks, imports). */
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

/** One rule: a selector-bearing rule is collected; a nested-rule grouping descends (a media condition replaces the outer one); anything else is ignored. */
function collectRule(
  rule: CSSRule,
  media: string | null,
  out: RuntimeRuleSelector[],
  bound: number,
): void {
  // The style-rule check comes FIRST, and the early return is the
  // point: a selector-bearing rule is collected AS ITSELF, and its
  // nested rules (CSS Nesting lets a style rule carry a NON-empty
  // `cssRules`) are deliberately OUT of this enumeration's scope — the
  // matched panel's truth is the document's own top-level selector
  // list. The check also keeps the grouping duck-type below from ever
  // misreading a style rule as a grouping.
  if (isStyleRule(rule)) {
    out.push({ selector: rule.selectorText, media });
    return;
  }
  if (isGrouping(rule)) {
    collectRules(listRules(rule.cssRules), mediaConditionOf(rule, media), out, bound);
  }
}

/** A selector-bearing rule — structural, realm-proof (never `instanceof CSSStyleRule`). */
function isStyleRule(rule: CSSRule): rule is CSSStyleRule {
  return 'selectorText' in rule;
}

/** A media rule — the one grouping whose condition the walk carries (conditionText beside a MediaList; supports/layer blocks carry no `media`). */
function isMediaRule(rule: CSSRule): rule is CSSMediaRule {
  return 'conditionText' in rule && 'media' in rule;
}

/** A rule carrying nested rules — the grouping forms the walk descends. */
function isGrouping(rule: CSSRule): rule is GroupingRuleLike {
  return 'cssRules' in rule && rule.cssRules !== null;
}

/** The nested walk's condition: a media rule's own condition, else the inherited one. */
function mediaConditionOf(rule: CSSRule, inherited: string | null): string | null {
  return isMediaRule(rule) ? rule.conditionText : inherited;
}
