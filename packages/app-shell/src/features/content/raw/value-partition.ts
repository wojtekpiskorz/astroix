import type { FormFieldNode } from '../../../../../core/src/form-tree.ts';

/**
 * The known/unknown value partition (#252, J2; CONTEXT.md "raw truth"):
 * the pure split of one entry's inspected values into the half the
 * walked schema tree claims (the widgets' editing space) and the half
 * no walked field claims (the explicit raw representation's half —
 * unknown fields never silently disappear from a draft).
 *
 * The two laws this module owns:
 *
 * - **Losslessness** — `mergeValues(partitionValues(fields, v).known,
 *   partitionValues(fields, v).unknown)` deep-equals `v` for every
 *   plain-record value tree (the property tests pin this): every leaf
 *   lands in exactly one half, at the DEEPEST claimed level, so unknown
 *   keys inside a walked group ride the unknown half under that group's
 *   key rather than being flattened away.
 * - **The raw-root exception** — a schema walk that degraded to the
 *   single root raw field (schema-less collections, unwalkable roots)
 *   claims the WHOLE value tree: the root raw widget is the editing
 *   surface for everything, and there is no unknown half at all.
 */

/** A plain record — the partition's recursion domain (arrays are leaves). */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The split: the walked tree's claimed half beside the unclaimed half. */
export interface ValuePartition {
  /** What the walked fields bind to — the widgets edit inside this half. */
  readonly known: unknown;
  /** Every key no walked field claims, nested at the enclosing group level. */
  readonly unknown: Record<string, unknown>;
}

/** True when the walked tree is the schema-less degradation: one root raw field. */
function isRawRooted(fields: readonly FormFieldNode[]): boolean {
  const root = fields[0];
  return fields.length === 1 && root?.kind === 'raw' && root.path === '';
}

/**
 * The field at one level that claims `key`: the child whose dotted path
 * is exactly `${prefix}.${key}` (the walk's own convention — group
 * children carry their absolute paths, so the claim test is exact,
 * never a prefix heuristic).
 */
function fieldFor(
  fields: readonly FormFieldNode[],
  prefix: string,
  key: string,
): FormFieldNode | undefined {
  const childPath = prefix === '' ? key : `${prefix}.${key}`;
  return fields.find((node) => node.path === childPath);
}

/**
 * Splits one value tree against one walked field tree. A non-record
 * value against an object-rooted tree is carried whole on the known
 * side (the validation lane's field issues name it — the partition
 * never invents a shape the file does not have).
 */
export function partitionValues(fields: readonly FormFieldNode[], values: unknown): ValuePartition {
  return partitionLevel(fields, values, '');
}

/** The partition's recursion: one record level against the fields whose paths live under `prefix`. */
function partitionLevel(
  fields: readonly FormFieldNode[],
  values: unknown,
  prefix: string,
): ValuePartition {
  if (prefix === '' && isRawRooted(fields)) return { known: values, unknown: {} };
  if (!isPlainRecord(values)) return { known: values, unknown: {} };
  const known: Record<string, unknown> = {};
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const field = fieldFor(fields, prefix, key);
    if (field === undefined) {
      // No walked field claims this key — the whole subtree rides the
      // unknown half untouched.
      unknown[key] = value;
      continue;
    }
    if (field.kind === 'group' && isPlainRecord(value)) {
      // The group claims its children; the group's own unclaimed inner
      // keys ride the unknown half under the group's key.
      const inner = partitionLevel(field.children, value, field.path);
      known[key] = inner.known;
      if (Object.keys(inner.unknown).length > 0) unknown[key] = inner.unknown;
      continue;
    }
    known[key] = value;
  }
  return { known, unknown };
}

/**
 * Merges the unknown half back over the known half — the draft's one
 * merge law. Unknown keys never collide with claimed paths (the
 * partition's own construction), so the unknown half's subtrees win
 * wholesale; the recursion only re-enters where both sides hold records
 * (the nested-group case). Total and lossless by construction: for any
 * record tree, this is the exact inverse of `partitionValues`.
 */
export function mergeValues(known: unknown, unknownPart: Record<string, unknown>): unknown {
  if (!isPlainRecord(known)) return known;
  if (Object.keys(unknownPart).length === 0) return known;
  const merged: Record<string, unknown> = { ...known };
  for (const [key, value] of Object.entries(unknownPart)) {
    if (isPlainRecord(merged[key]) && isPlainRecord(value)) {
      merged[key] = mergeValues(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}
