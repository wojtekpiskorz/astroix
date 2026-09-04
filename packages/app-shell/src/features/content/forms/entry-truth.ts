import type { FormFieldNode, ValidationIssueRecord } from '../../../../../core/src/form-tree.ts';

/**
 * The forms slice's E4 binding (#252, J2): the typed, structural bind
 * of one ACTIVE entry's slice of the content-inspection payload — the
 * walked schema tree beside the inspected values, the entry's SHA-256
 * revision, the project's own issue verdict, and the body carried
 * untouched. Same discipline as J1's discovery binders
 * (`features/content/api.ts`): the protocol keeps payload interiors
 * opaque; this module binds structurally and a drifted interior binds
 * to the `drift` outcome — the diagnostic state, never a heuristic
 * parse (a seam drift is a compatibility event).
 *
 * What this binder deliberately drops, like J1's: `filePath` (the UI
 * never reads a source path — the raw truth arrives through the
 * payload's values, not the filesystem).
 */

/** One active entry's inspected truth — the draft's baseline and nothing else. */
export interface EntryTruth {
  readonly collection: string;
  readonly entryId: string;
  /** Whether the project's content config declared a schema for the collection. */
  readonly schemaDeclared: boolean;
  /** The walked field tree (the frozen form-tree walk over the project's own schema). */
  readonly fields: readonly FormFieldNode[];
  /**
   * The inspected values — the payload's `data`, the project's actual
   * parse output verbatim (the zod projection; CONTEXT.md). Display and
   * draft baseline in J2; J3's write lane is where the raw-truth
   * anchoring begins.
   */
  readonly values: unknown;
  /** The entry's raw markdown body as inspected — carried untouched; not J2's editing surface. */
  readonly body: string | null;
  /** The entry file's SHA-256 at inspection (the future write intent's baseline); null file-less. */
  readonly revision: string | null;
  /** The project's own schema validation of the entry's raw truth, as inspected; null when none ran. */
  readonly inspectedIssues: readonly ValidationIssueRecord[] | null;
  /** The collection's revision — the schema+config semantics signal (over-invalidation by construction). */
  readonly collectionRevision: string;
}

/** The bind outcome: the truth, or the honest non-truth state. */
export type EntryTruthOutcome =
  | { readonly outcome: 'truth'; readonly truth: EntryTruth }
  /** The collection or entry is not in the payload — an honest absent state. */
  | { readonly outcome: 'absent' }
  /** The payload interior drifted — a compatibility event, never a heuristic parse. */
  | { readonly outcome: 'drift' };

/** Narrows one unknown to a plain record. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** One nonempty string, or null. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The walked node's shared base fields, as the binders thread them. */
interface NodeBaseFields {
  readonly path: string;
  readonly label: string;
  readonly required: boolean;
  readonly initial?: unknown;
}

/** The walked node kinds with no kind-specific payload to bind. */
const SIMPLE_NODE_KINDS = ['string', 'number', 'boolean', 'image'] as const;
type SimpleNodeKind = (typeof SIMPLE_NODE_KINDS)[number];

/** Binds a string-or-number options list — the enum vocabularies' shared shape. */
function bindOptions(value: unknown): (string | number)[] | null {
  if (!Array.isArray(value)) return null;
  const options: (string | number)[] = [];
  for (const option of value) {
    if (typeof option !== 'string' && typeof option !== 'number') return null;
    options.push(option);
  }
  return options;
}

/** Binds one enum node — the declared options, all string-or-number. */
function bindEnumNode(record: Record<string, unknown>, base: NodeBaseFields): FormFieldNode | null {
  const options = bindOptions(record.options);
  return options === null ? null : { kind: 'enum', options, ...base };
}

/** Binds one array node — the item kind, plus the item enum's options when the item is one. */
function bindArrayNode(
  record: Record<string, unknown>,
  base: NodeBaseFields,
): FormFieldNode | null {
  const item = asRecord(record.item);
  if (item === null) return null;
  if (
    item.kind !== 'string' &&
    item.kind !== 'number' &&
    item.kind !== 'boolean' &&
    item.kind !== 'enum'
  ) {
    return null;
  }
  const options = item.kind === 'enum' ? bindOptions(item.options) : undefined;
  if (options === null) return null;
  return {
    kind: 'array',
    item: { kind: item.kind, ...(options === undefined ? {} : { options }) },
    ...base,
  };
}

/** Binds one group node — the children walk, recursively, all-or-nothing. */
function bindGroupNode(
  record: Record<string, unknown>,
  base: NodeBaseFields,
): FormFieldNode | null {
  if (!Array.isArray(record.children)) return null;
  const children: FormFieldNode[] = [];
  for (const child of record.children) {
    const bound = bindFieldNode(child);
    if (bound === null) return null;
    children.push(bound);
  }
  return { kind: 'group', children, ...base };
}

/** The kind-specific binders — the dispatch table `bindFieldNode` reads. */
const NODE_KIND_BINDERS: Record<
  string,
  (record: Record<string, unknown>, base: NodeBaseFields) => FormFieldNode | null
> = {
  enum: bindEnumNode,
  array: bindArrayNode,
  group: bindGroupNode,
};

/** Binds the kind-specific slice of one node — the per-kind binders' dispatch. */
function bindKindSlice(
  record: Record<string, unknown>,
  base: NodeBaseFields,
): FormFieldNode | null {
  const kind = record.kind;
  if (typeof kind !== 'string') return null;
  if ((SIMPLE_NODE_KINDS as readonly string[]).includes(kind)) {
    return { kind: kind as SimpleNodeKind, ...base };
  }
  if (kind === 'raw') {
    const reason = nonEmptyString(record.reason);
    return reason === null ? null : { kind: 'raw', reason, ...base };
  }
  return (NODE_KIND_BINDERS[kind] ?? (() => null))(record, base);
}

/** Binds one walked-tree node — every kind structural, one drift rejects the walk. */
function bindFieldNode(value: unknown): FormFieldNode | null {
  const record = asRecord(value);
  if (record === null) return null;
  const path = typeof record.path === 'string' ? record.path : null;
  const label = typeof record.label === 'string' ? record.label : null;
  const required = typeof record.required === 'boolean' ? record.required : null;
  if (path === null || label === null || required === null) return null;
  const base: NodeBaseFields = {
    path,
    label,
    required,
    ...(record.initial !== undefined ? { initial: record.initial } : {}),
  };
  return bindKindSlice(record, base);
}

/** Binds a collection's schema result — declared plus the walked tree. */
function bindSchema(value: unknown): { declared: boolean; fields: FormFieldNode[] } | null {
  const record = asRecord(value);
  if (record === null) return null;
  if (typeof record.declared !== 'boolean' || !Array.isArray(record.fields)) return null;
  const fields: FormFieldNode[] = [];
  for (const node of record.fields) {
    const bound = bindFieldNode(node);
    if (bound === null) return null;
    fields.push(bound);
  }
  return { declared: record.declared, fields };
}

/** Binds one issue record — the project's own verdict vocabulary. */
function bindIssue(value: unknown): ValidationIssueRecord | null {
  const record = asRecord(value);
  if (record === null) return null;
  const path = typeof record.path === 'string' ? record.path : null;
  const code = nonEmptyString(record.code);
  const message = typeof record.message === 'string' ? record.message : null;
  if (path === null || code === null || message === null) return null;
  return { path, code, message };
}

/** Binds the issues field: an array of issue records, or null. */
function bindIssues(value: unknown): ValidationIssueRecord[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) return null;
  const issues: ValidationIssueRecord[] = [];
  for (const candidate of value) {
    const issue = bindIssue(candidate);
    if (issue === null) return null;
    issues.push(issue);
  }
  return issues;
}

/** Binds one entry record — the interior the forms slice consumes. */
function bindEntry(value: unknown): {
  values: unknown;
  body: string | null;
  revision: string | null;
  issues: ValidationIssueRecord[] | null;
} | null {
  const record = asRecord(value);
  if (record === null) return null;
  // `data` is the inspected values — any shape is a carried truth (the
  // schema-less and unwalkable cases carry whole trees); only its
  // WRAPPER is structural. `body`/`revision`/`issues` must be PRESENT
  // (the runtime serializes every field), with `null` a carried truth
  // (file-less, body-less) — never a drift.
  if (!('data' in record) || !('body' in record) || !('revision' in record)) return null;
  if (!('issues' in record)) return null;
  if (typeof record.body !== 'string' && record.body !== null) return null;
  if (typeof record.revision !== 'string' && record.revision !== null) return null;
  const issues = bindIssues(record.issues);
  if (issues === null && record.issues !== null) return null;
  return {
    values: record.data,
    body: record.body,
    revision: record.revision,
    issues,
  };
}

/** Finds the named record in a payload array by one string field — the shared lookup. */
function findNamedRecord(
  candidates: readonly unknown[],
  field: string,
  expected: string,
): Record<string, unknown> | null {
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (record !== null && record[field] === expected) return record;
  }
  return null;
}

/** Binds the target collection's outer truth: revision, schema, entries array. */
function bindCollectionSlice(collection: Record<string, unknown>): {
  revision: string;
  declared: boolean;
  fields: FormFieldNode[];
  entries: readonly unknown[];
} | null {
  const revision = nonEmptyString(collection.revision);
  const schema = bindSchema(collection.schema);
  if (revision === null || schema === null) return null;
  if (!Array.isArray(collection.entries)) return null;
  return {
    revision,
    declared: schema.declared,
    fields: schema.fields,
    entries: collection.entries,
  };
}

/**
 * Binds the active entry's slice of one content-inspection payload.
 * Structural over exactly what the forms slice consumes — the target
 * collection's schema tree and the target entry's interior; other
 * collections' interiors are not this binder's claim (J1's discovery
 * binder owns their listing projection).
 */
export function bindEntryTruth(
  payload: unknown,
  collection: string,
  entryId: string,
): EntryTruthOutcome {
  const record = asRecord(payload);
  if (record === null || !Array.isArray(record.collections)) return { outcome: 'drift' };
  const boundCollection = findNamedRecord(record.collections, 'name', collection);
  if (boundCollection === null) return { outcome: 'absent' };
  const slice = bindCollectionSlice(boundCollection);
  if (slice === null) return { outcome: 'drift' };
  const boundEntry = findNamedRecord(slice.entries, 'id', entryId);
  if (boundEntry === null) return { outcome: 'absent' };
  const entry = bindEntry(boundEntry);
  if (entry === null) return { outcome: 'drift' };
  return {
    outcome: 'truth',
    truth: {
      collection,
      entryId,
      schemaDeclared: slice.declared,
      fields: slice.fields,
      values: entry.values,
      body: entry.body,
      revision: entry.revision,
      inspectedIssues: entry.issues,
      collectionRevision: slice.revision,
    },
  };
}
