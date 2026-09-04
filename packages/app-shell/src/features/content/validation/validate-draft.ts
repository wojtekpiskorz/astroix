import type { FormFieldNode, ValidationIssueRecord } from '../../../../../core/src/form-tree.ts';
import { isPlainRecord } from '../raw/value-partition.ts';

/**
 * The draft-validation lane (#252, J2): the DETERMINISTIC, pure report
 * over a draft's values against the walked schema tree, the raw parse
 * state, and the inspected revision — reporting only, never gating a
 * write (no write exists in J2; J3 consumes the validated intent).
 *
 * The four diagnostic kinds, deliberately distinguished (the AC's own
 * vocabulary — the tests pin each):
 *
 * - **field** — a value's SHAPE contradicts its walked kind: a string
 *   field holding a number, a number field holding a non-finite value,
 *   a boolean holding a string, an array holding a non-array. Born from
 *   raw-space edits (YAML admits any shape) — the widgets cannot
 *   produce these.
 * - **schema** — the walked tree's declared constraints: a required
 *   field whose key is absent, an enum value outside the declared
 *   options (top-level or inside an array). These are schema truth the
 *   WALK carries, evaluated client-side; the project's own zod verdict
 *   on the entry's raw truth is a separate, server-inspected surface
 *   (`inspectedIssues`), never re-derived here.
 * - **parse** — the raw pane's text failed YAML parsing; the draft
 *   keeps the last parsed values and the document carries one parse
 *   issue until the text parses again.
 * - **stale-baseline** — the live inspection's entry revision moved
 *   off the revision the draft began from: the entry changed on disk
 *   (or lost its file) under the draft. The draft survives untouched;
 *   the report names it so J3's write lane (and the user) never trust a
 *   moved-past baseline.
 */

/** The four diagnostic kinds — the AC's vocabulary, one per source of truth. */
export type DraftIssueKind = 'field' | 'schema' | 'parse' | 'stale-baseline';

/** One draft diagnostic — `path` is the dotted field path, `''` the document. */
export interface DraftIssue {
  readonly kind: DraftIssueKind;
  readonly path: string;
  readonly message: string;
}

/** The validation report: every issue, the inline map, and the clean verdict. */
export interface DraftValidation {
  readonly issues: readonly DraftIssue[];
  /** Inline (field/schema) issues by dotted path, joined — the form widgets' display map. */
  readonly inline: Record<string, string>;
  /** True when no issue of any kind stands. */
  readonly clean: boolean;
}

/** The draft-validation input — everything the report reads, nothing it writes. */
export interface ValidateDraftInput {
  readonly fields: readonly FormFieldNode[];
  readonly values: unknown;
  /** The raw pane's standing parse failure, or null while the text parses. */
  readonly parseError: string | null;
  /** The entry revision the draft began from (the inspected SHA-256, or null file-less). */
  readonly baselineRevision: string | null;
  /** The LIVE inspection's revision for the same entry, or null when file-less now. */
  readonly liveRevision: string | null;
}

/** Reads a dotted path out of a plain-object tree — absent middle segments read undefined. */
function pickPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split('.')) {
    if (!isPlainRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Joins one issue into the accumulating report. */
function add(
  issues: DraftIssue[],
  inline: Record<string, string>,
  kind: DraftIssueKind,
  path: string,
  message: string,
): void {
  issues.push({ kind, path, message });
  if (kind === 'field' || kind === 'schema') {
    inline[path] = inline[path] === undefined ? message : `${inline[path]}; ${message}`;
  }
}

/** The primitive shape check one leaf's kind demands — `null` passes (the walk's `required` already peeled nullable). */
function leafShapeMessage(kind: 'string' | 'number' | 'boolean', value: unknown): string | null {
  switch (kind) {
    case 'string':
      return typeof value === 'string' ? null : 'must be a string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be a boolean';
  }
}

/** Validates one array item against the item kind (the row widgets' own shapes). */
function validateArrayItem(
  issues: DraftIssue[],
  inline: Record<string, string>,
  node: Extract<FormFieldNode, { kind: 'array' }>,
  values: unknown,
): void {
  const rows = Array.isArray(values) ? values : [];
  rows.forEach((row, index) => {
    const itemPath = `${node.path}.${index}`;
    const kind = node.item.kind;
    if (kind === 'enum') {
      const options = node.item.options ?? [];
      if (!options.includes(row as string | number)) {
        add(issues, inline, 'schema', itemPath, `must be one of: ${options.join(', ')}`);
      }
      return;
    }
    const message = leafShapeMessage(kind, row);
    if (message !== null) add(issues, inline, 'field', itemPath, message);
  });
}

/** Validates one present leaf value against its kind — string/number/boolean shapes and enum membership. */
function validateLeafValue(
  issues: DraftIssue[],
  inline: Record<string, string>,
  node: FormFieldNode,
  value: unknown,
): void {
  if (node.kind === 'string' || node.kind === 'number' || node.kind === 'boolean') {
    const message = leafShapeMessage(node.kind, value);
    if (message !== null) add(issues, inline, 'field', node.path, message);
    return;
  }
  if (node.kind === 'enum') {
    if (!node.options.includes(value as string | number)) {
      add(issues, inline, 'schema', node.path, `must be one of: ${node.options.join(', ')}`);
    }
    return;
  }
  // image: display-only (the picker is deferred) — the projection's
  // metadata round-trips untouched; no shape check is honest here.
  // raw: any shape is the raw field's purpose — the raw space's own
  // parse diagnostics are the pane's, not a shape constraint's.
}

/** Validates one present array value: the array shape plus every row's item kind. */
function validateArrayValue(
  issues: DraftIssue[],
  inline: Record<string, string>,
  node: FormFieldNode,
  values: unknown,
  value: unknown,
): void {
  if (node.kind !== 'array') return;
  if (!Array.isArray(value)) {
    add(issues, inline, 'field', node.path, 'must be an array');
    return;
  }
  validateArrayItem(issues, inline, node, value);
}

/** Validates one present group value: the record shape, then every child. */
function validateGroupValue(
  issues: DraftIssue[],
  inline: Record<string, string>,
  node: FormFieldNode,
  values: unknown,
  value: unknown,
): void {
  if (node.kind !== 'group') return;
  if (!isPlainRecord(value)) {
    add(issues, inline, 'field', node.path, 'must be an object');
    return;
  }
  for (const child of node.children) {
    validateNode(issues, inline, child, values);
  }
}

/** Validates one walked node — recursion happens at groups. */
function validateNode(
  issues: DraftIssue[],
  inline: Record<string, string>,
  node: FormFieldNode,
  values: unknown,
): void {
  const value = pickPath(values, node.path);

  // The widget-display space: an absent key is only a schema issue when
  // the walk says required. (The E4 payload's values are the zod
  // projection — defaults arrive filled — but a raw-space edit can
  // delete a key; required-missing is the honest report.)
  if (value === undefined) {
    if (node.required) {
      add(issues, inline, 'schema', node.path, 'is required');
    }
    return;
  }

  validateLeafValue(issues, inline, node, value);
  validateArrayValue(issues, inline, node, values, value);
  validateGroupValue(issues, inline, node, values, value);
}

/** The empty report — no values, no text, no revision movement. */
export const CLEAN_VALIDATION: DraftValidation = { issues: [], inline: {}, clean: true };

/**
 * Computes the draft's full validation report — pure over its input;
 * the caller renders it and nothing else. The report never inspects
 * the entry's server-side issues (`inspectedIssues`): those are the
 * project's own verdict on its raw truth, displayed verbatim beside
 * this report, never conflated with the draft's diagnostics.
 */
export function validateDraft(input: ValidateDraftInput): DraftValidation {
  const issues: DraftIssue[] = [];
  const inline: Record<string, string> = {};
  for (const node of input.fields) {
    validateNode(issues, inline, node, input.values);
  }
  if (input.parseError !== null) {
    issues.push({ kind: 'parse', path: '', message: input.parseError });
  }
  if (input.baselineRevision !== input.liveRevision) {
    issues.push({
      kind: 'stale-baseline',
      path: '',
      message:
        'the entry changed on disk since this draft began (the inspected revision moved) — ' +
        're-open the entry to draft against the current truth',
    });
  }
  if (issues.length === 0) return CLEAN_VALIDATION;
  return { issues, inline, clean: false };
}

/** One server-inspected issue as the pane renders it (the project's own zod verdict, verbatim). */
export type InspectedIssue = ValidationIssueRecord;
