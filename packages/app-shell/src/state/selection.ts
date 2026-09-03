/**
 * The canvas selection's re-matchable identity (#242, G3; CONTEXT.md
 * "selection": "the currently clicked element in the app shell; it
 * survives reindex (re-matched after file changes)"). A selection is
 * never a live element reference in state — it is the element's stable
 * DOM identity (tag, id, classes, Astro scope attributes), held so the
 * canvas can RE-FIND the element after an eligible reload or an HMR
 * update rebuilds the document, and RE-MATCH it against the runtime
 * effective selectors of whatever document is live then.
 *
 * Matching is `Element.matches` in the canvas document's own realm, run
 * against the runtime effective selectors (`canvas/canvas-rules.ts`
 * enumerates them from the live document's own stylesheets — the
 * compiled scoped forms `[data-astro-cid-*]` verbatim, never
 * synthesized). When the CSS vertical lands, its index payload's
 * effective selectors flow through the same `matchedSelectors` seam;
 * the matching law itself is settled here.
 */

/** Astro's scoped-style attribute prefix — the scope token of the effective-selector world (the `attribute` scopedStyleStrategy). */
const SCOPE_ATTRIBUTE_PREFIX = 'data-astro-cid-';

/**
 * One selected canvas element's stable identity — everything needed to
 * re-find the element after the document it was picked from is gone.
 */
export interface SelectionDescriptor {
  readonly tag: string;
  readonly id: string | null;
  readonly classes: readonly string[];
  /** The element's Astro scope attributes (`data-astro-cid-*`) — its scoped-selector identity. */
  readonly scopeAttributes: readonly string[];
}

/** One runtime rule selector as the canvas document carries it: the effective form, plus its media condition when the rule is conditional. */
export interface RuntimeRuleSelector {
  readonly selector: string;
  readonly media: string | null;
}

/** One matched rule selector of a selection — the runtime selector plus its media condition. */
export type SelectionMatch = RuntimeRuleSelector;

/** Reads one element's re-matchable identity. */
export function selectionDescriptorOf(element: Element): SelectionDescriptor {
  const scopeAttributes: string[] = [];
  for (const name of element.getAttributeNames()) {
    if (name.startsWith(SCOPE_ATTRIBUTE_PREFIX)) scopeAttributes.push(name);
  }
  return {
    tag: element.tagName.toLowerCase(),
    id: element.id === '' ? null : element.id,
    classes: [...element.classList],
    scopeAttributes,
  };
}

/** Composes the descriptor's re-match selector — `tag#id.class…[data-astro-cid-…]…`. */
export function selectionSelector(descriptor: SelectionDescriptor): string {
  const id = descriptor.id === null ? '' : `#${cssEscapeIdent(descriptor.id)}`;
  const classes = descriptor.classes.map((name) => `.${cssEscapeIdent(name)}`).join('');
  const scope = descriptor.scopeAttributes.map((name) => `[${name}]`).join('');
  return `${descriptor.tag}${id}${classes}${scope}`;
}

/**
 * Re-finds the selected element in a live document — `null` when this
 * reload was not eligible for it, and `null` when the composed selector
 * is one the engine rejects (a descriptor carrying an identifier no
 * escape can make parseable — a lone surrogate, say). The query is
 * guarded exactly like `matchesSelector`: a bad selector is a
 * non-rematch, never a crash of the recompute pass.
 */
export function rematchSelection(
  root: ParentNode,
  descriptor: SelectionDescriptor,
): Element | null {
  try {
    return root.querySelector(selectionSelector(descriptor));
  } catch {
    return null;
  }
}

/**
 * Matches one element against runtime effective selectors through
 * `Element.matches` — the selection's matching law (the AC's exact
 * seam). An unparseable selector never matches and never breaks the
 * pass: the panel stays honest, the loop continues.
 */
export function matchedSelectors(
  element: Element,
  candidates: readonly RuntimeRuleSelector[],
): readonly SelectionMatch[] {
  const matched: SelectionMatch[] = [];
  for (const candidate of candidates) {
    if (matchesSelector(element, candidate.selector)) matched.push(candidate);
  }
  return matched;
}

/** One guarded `Element.matches` — a DOMException for a bad selector is a non-match, never a crash. */
function matchesSelector(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

/** The identifier characters that need no escaping in a selector (the CSS.escape ident set, self-carried — no engine-global dependency). */
const IDENTIFIER_CHAR =
  /[-\w\u{00b7}\u{00c0}-\u{00d6}\u{00d8}-\u{00f6}\u{00f8}-\u{037d}\u{037f}-\u{1fff}\u{200c}-\u{200d}\u{203f}\u{2040}\u{2070}-\u{218f}\u{2c00}-\u{2fef}\u{3001}-\u{d7ff}\u{f900}-\u{fdcf}\u{fdf0}-\u{fffd}\u{10000}-\u{effff}]/u;

/**
 * Escapes one identifier token (an id or class name) for selector
 * composition. Iterates CODE POINTS (`for…of` semantics), never UTF-16
 * units: an astral identifier the DOM legally carries must pass (or
 * escape) as one character — the escape set's `\u{10000}-\u{effff}`
 * range is unreachable from a per-unit loop.
 */
export function cssEscapeIdent(value: string): string {
  let escaped = '';
  let index = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    // A leading digit (or a digit right after a leading hyphen) cannot
    // start an identifier — it escapes as a hex code point.
    const leadingDigit =
      code >= 0x30 && code <= 0x39 && (index === 0 || (index === 1 && value.startsWith('-')));
    if (leadingDigit) {
      escaped += `\\${code.toString(16)} `;
    } else if (IDENTIFIER_CHAR.test(char)) {
      escaped += char;
    } else {
      escaped += `\\${char}`;
    }
    index += 1;
  }
  return escaped;
}
