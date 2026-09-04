/**
 * The rule editor's declaration parsing (#250, I2): one matched
 * record's rule text — the raw slice at the record's range — parsed
 * into its selector head and top-level declarations, each carrying its
 * exact bounds INSIDE the rule text (the splice planner lifts them
 * into file space by adding the record's range start). Pure over the
 * served raw truth; no offsets are guessed, nothing is reprinted — a
 * declaration's bounds are its trimmed source text plus its trailing
 * semicolon when the source carries one, exactly the frozen
 * `css-splice` contract's replaced-slice species (`font-size: 3rem;`).
 *
 * Fail-closed on shape: a rule text without a top-level `{` … `}`
 * body, or a body that is not a flat declaration list, parses to
 * `null` — the editor refuses rather than splice into a structure it
 * could not locate byte-exactly (nested at-rules are read-only truth
 * for the pre-alpha, surfaced by the read list's media metadata).
 */

/** One parsed declaration — its exact source text and its bounds inside the rule text. */
export interface ParsedDeclaration {
  /** The declaration's property (`font-size`). */
  readonly property: string;
  /** The declaration's current value (`3rem`). */
  readonly value: string;
  /** The declaration's exact source text (`font-size: 3rem;`) — the splice proof's expectation. */
  readonly text: string;
  /** The declaration's bounds inside the RULE text (UTF-16 indices, end-exclusive). */
  readonly start: number;
  readonly end: number;
}

/** One parsed rule — its selector head and its flat declaration list. */
export interface ParsedRule {
  /** The rule's selector head as written (`.hero-title`). */
  readonly selector: string;
  readonly declarations: readonly ParsedDeclaration[];
}

/** The bounds of the selector head inside the rule text (for selector splices). */
export function selectorHeadBounds(ruleText: string): { start: number; end: number } | null {
  const brace = ruleText.indexOf('{');
  if (brace === -1) return null;
  const head = ruleText.slice(0, brace);
  const start = head.length - head.trimStart().length;
  const trimmed = head.trim();
  if (trimmed.length === 0) return null;
  return { start, end: start + trimmed.length };
}

/**
 * Parses one rule text — the selector head plus the body's flat
 * declaration list, every bound RULE-relative (the head starts at 0 for
 * a well-formed record). The body closes at the FIRST closing brace —
 * a media-conditioned record's range over-covers its enclosing at-rule
 * (the corpus's own media records end with the at-rule's `}`), and the
 * rule's own body is what precedes the first close. `null` when the
 * body is not a flat list (a nested block, or a segment without a
 * property/value pair) — the honest read-only refusal, never a
 * heuristic splice.
 */
/**
 * Binds one body segment into a declaration — `null` when the segment
 * is not a property/value pair (the honest refusal), `{ skip: true }`
 * for blank filler between semicolons. `hasSemicolon` carries whether
 * the source wrote a `;` after this segment (the declaration's own
 * text includes it when it did).
 */
function bindSegment(
  segment: string,
  start: number,
  offset: number,
  hasSemicolon: boolean,
): { readonly skip: boolean; readonly declaration?: ParsedDeclaration } | null {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return { skip: true };
  const colon = trimmed.indexOf(':');
  if (colon <= 0 || colon === trimmed.length - 1) return null;
  const property = trimmed.slice(0, colon).trim();
  const value = trimmed.slice(colon + 1).trim();
  if (property.length === 0 || value.length === 0) return null;
  const lead = segment.length - segment.trimStart().length;
  const declStart = offset + start + lead;
  return {
    skip: false,
    declaration: {
      property,
      value,
      text: `${trimmed}${hasSemicolon ? ';' : ''}`,
      start: declStart,
      end: declStart + trimmed.length + (hasSemicolon ? 1 : 0),
    },
  };
}

export function parseRule(ruleText: string): ParsedRule | null {
  const brace = ruleText.indexOf('{');
  const close = ruleText.indexOf('}');
  if (brace === -1 || close === -1 || close < brace) return null;
  const head = ruleText.slice(0, brace).trim();
  if (head.length === 0) return null;
  const body = ruleText.slice(brace + 1, close);
  // A nested block (an at-rule's inner rule) makes the body non-flat —
  // read-only truth for the pre-alpha.
  if (body.includes('{') || body.includes('}')) return null;
  const declarations: ParsedDeclaration[] = [];
  // Body offsets become rule offsets through the `{`'s position + 1.
  const offset = brace + 1;
  let cursor = 0;
  const segments = body.split(';');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    const start = cursor;
    cursor += segment.length + 1;
    // The trailing `;` belongs to the declaration's written text when
    // the source carries one after this segment — every segment but
    // the last, plus the last when the body ends with `;`.
    const bound = bindSegment(
      segment,
      start,
      offset,
      index < segments.length - 1 || body.endsWith(';'),
    );
    if (bound === null) return null;
    if (bound.declaration !== undefined) declarations.push(bound.declaration);
  }
  return { selector: head, declarations };
}

/**
 * The next declaration text for one property/value pair — the frozen
 * contract's own serialization species: `${property}: ${value};`. The
 * planner composes the replacement through this one function, so the
 * written shape can never drift from the corpus's shape.
 */
export function declarationText(property: string, value: string): string {
  return `${property}: ${value};`;
}
