import type { CssRuleRecord } from './indexer';

/**
 * Index payload record: an edit-truth rule joined with the compiled selector
 * form the module graph observed on the current route. `effectiveSelector` is
 * null when the rule's file is not loaded there — the REST slice owns this
 * join (module-graph hybrid); the matcher never synthesizes cid forms.
 */
export interface IndexPayloadRecord extends CssRuleRecord {
  effectiveSelector: string | null;
}

/** A rule that matched the clicked element, positioned in the specificity sort. */
export interface MatchedRule {
  record: IndexPayloadRecord;
  /** Specificity (ids, classes/attributes/pseudo-classes, types) of the matching selector. */
  specificity: [number, number, number];
  /** The cascade winner: first of the specificity sort (rule-level, v1; ties keep source order). */
  winner: boolean;
}

type Specificity = [number, number, number];

/**
 * The matcher: given the index payload and a clicked canvas element, return
 * matching rules sorted by specificity with the winner marked. `el.matches()`
 * runs in the element's own document context; `@media` conditions pass through
 * untouched (badge data, never evaluated in v1).
 */
export function matchRules(records: IndexPayloadRecord[], element: Element): MatchedRule[] {
  const matches: Array<{ record: IndexPayloadRecord; specificity: Specificity; order: number }> =
    [];

  records.forEach((record, order) => {
    const selector = matchingSelector(record);
    if (selector === null) return;
    try {
      if (!element.matches(selector)) return;
    } catch {
      // An unparseable selector in someone's CSS must not take the chrome down.
      return;
    }
    matches.push({ record, specificity: selectorListSpecificity(selector), order });
  });

  return matches
    .toSorted((a, b) => compareSpecificity(b.specificity, a.specificity) || a.order - b.order)
    .map(({ record, specificity }, i) => ({ record, specificity, winner: i === 0 }));
}

/** Scoped rules match only in their compiled form; global rules in their source form. */
function matchingSelector(record: IndexPayloadRecord): string | null {
  if (record.scoped) {
    return record.effectiveSelector;
  }
  return record.effectiveSelector ?? record.selector;
}

function compareSpecificity(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** A rule's specificity is the most specific selector of its list. */
function selectorListSpecificity(selectorList: string): Specificity {
  let max: Specificity = [0, 0, 0];
  for (const part of splitTopLevel(selectorList, ',')) {
    const specificity = selectorSpecificity(part.trim());
    if (compareSpecificity(specificity, max) > 0) {
      max = specificity;
    }
  }
  return max;
}

function selectorSpecificity(selector: string): Specificity {
  const spec: Specificity = [0, 0, 0];
  let i = 0;
  while (i < selector.length) {
    const char = selector[i];
    if (char === '#') {
      spec[0] += 1;
      i = skipName(selector, i + 1);
    } else if (char === '.') {
      spec[1] += 1;
      i = skipName(selector, i + 1);
    } else if (char === '[') {
      spec[1] += 1;
      i = skipBlock(selector, i, '[', ']') + 1;
    } else if (char === ':') {
      if (selector[i + 1] === ':') {
        spec[2] += 1;
        i = skipName(selector, i + 2);
        continue;
      }
      const nameEnd = skipName(selector, i + 1);
      const name = selector.slice(i + 1, nameEnd);
      if (selector[nameEnd] === '(') {
        const close = skipBlock(selector, nameEnd, '(', ')');
        addSpecificity(
          spec,
          functionalPseudoContribution(name, selector.slice(nameEnd + 1, close)),
        );
        i = close + 1;
      } else {
        spec[1] += 1;
        i = nameEnd;
      }
    } else if (/[a-zA-Z]/.test(char ?? '')) {
      spec[2] += 1;
      i = skipName(selector, i);
    } else {
      i += 1;
    }
  }
  return spec;
}

/**
 * Functional pseudo-classes: `:where()` is zero, `:is()`/`:not()`/`:has()`
 * take their most specific argument (the pseudo itself contributes nothing),
 * everything else (`:nth-child()`…) counts as one pseudo-class.
 */
function functionalPseudoContribution(name: string, inner: string): Specificity {
  if (name === 'where') {
    return [0, 0, 0];
  }
  if (name === 'is' || name === 'not' || name === 'has') {
    return selectorListSpecificity(inner);
  }
  return [0, 1, 0];
}

function addSpecificity(spec: Specificity, contribution: Specificity): void {
  spec[0] += contribution[0];
  spec[1] += contribution[1];
  spec[2] += contribution[2];
}

function skipName(selector: string, from: number): number {
  let i = from;
  while (i < selector.length && /[a-zA-Z0-9_-]/.test(selector[i] ?? '')) {
    i += 1;
  }
  return i;
}

function skipBlock(selector: string, open: number, openChar: string, closeChar: string): number {
  let depth = 0;
  for (let i = open; i < selector.length; i++) {
    const char = selector[i];
    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return selector.length - 1;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.filter((part) => part.trim() !== '');
}
