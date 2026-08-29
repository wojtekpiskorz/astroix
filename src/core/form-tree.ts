/**
 * The schema def-walk (spec Impl #4, #72): a pure, structural walk over a
 * zod 4 schema's `_zod.def` tree producing the JSON field tree the chrome
 * renders widgets from. Structural on purpose — the walked instance comes
 * from the project's own zod through the module runner, and nothing here
 * instanceof-checks against a second zod copy ("no instanceof hell", ticket
 * #72). `z.toJSONSchema()` is deliberately not used: it loses zod-specific
 * shapes (astro's `image()`, function schemas, wrappers) that the walk reads
 * directly.
 */

/** A leaf widget kind. `image` renders read-only metadata (picker deferred). */
export type PrimitiveKind = 'string' | 'number' | 'boolean' | 'enum' | 'image';

/** The `enum` options as declared (strings, or numbers via nativeEnum). */
export type EnumOptions = (string | number)[];

interface NodeBase {
  /** Dotted path into the entry's data (`cta.label`); `''` = the whole frontmatter. */
  path: string;
  /** Last path segment, human-facing. */
  label: string;
  /** False when any optional/nullable/default wrapper was peeled. */
  required: boolean;
  /** The schema's `defaultValue` when present (zod fills it into `entry.data` too). */
  initial?: unknown;
}

export interface StringFieldNode extends NodeBase {
  kind: 'string';
}
export interface NumberFieldNode extends NodeBase {
  kind: 'number';
}
export interface BooleanFieldNode extends NodeBase {
  kind: 'boolean';
}
export interface EnumFieldNode extends NodeBase {
  kind: 'enum';
  options: EnumOptions;
}
/** Read-only `src`/`width`/`height` from `entry.data`; the value round-trips untouched. */
export interface ImageFieldNode extends NodeBase {
  kind: 'image';
}
/** Array of primitives → repeatable rows; anything else walks to a raw field. */
export interface ArrayFieldNode extends NodeBase {
  kind: 'array';
  item: { kind: 'string' | 'number' | 'boolean' | 'enum'; options?: EnumOptions };
}
/** Nested object → fieldset. */
export interface GroupFieldNode extends NodeBase {
  kind: 'group';
  children: FormFieldNode[];
}
/**
 * The raw field (glossary): a clearly-marked textarea holding that subtree's
 * YAML — the convention resolving every unsupported schema node (unions,
 * transforms/pipes, records, dates, literals…): every schema opens in the
 * builder, odd fields stay editable, just widgetless.
 */
export interface RawFieldNode extends NodeBase {
  kind: 'raw';
  /** The zod def type that fell through the mapping. */
  reason: string;
}

export type FormFieldNode =
  | StringFieldNode
  | NumberFieldNode
  | BooleanFieldNode
  | EnumFieldNode
  | ImageFieldNode
  | ArrayFieldNode
  | GroupFieldNode
  | RawFieldNode;

export interface WalkOptions {
  /**
   * Recognizes astro's `image()` schemas. Astro injects `image()` into
   * function schemas (`schema: ({ image }) => …`) and its real form is
   * `z.string().transform(...)` — indistinguishable from any user transform.
   * The server-side resolver substitutes its own stub instances and passes
   * their membership here; by default nothing is an image.
   */
  isImage?: (schema: unknown) => boolean;
}

/** One zod issue as served to the chrome (`POST /__astroix/content-validate`). */
export interface ValidationIssueRecord {
  /** Dotted path into the draft (`cta.label`, `tags.0`); `''` = the root. */
  path: string;
  code: string;
  message: string;
}

/** Maps zod's issues to the served records — structural (path keys join by code unit). */
export function toIssueRecords(
  issues: Iterable<{ path?: readonly PropertyKey[]; code?: unknown; message: unknown }>,
): ValidationIssueRecord[] {
  const records: ValidationIssueRecord[] = [];
  for (const issue of issues) {
    const path = (issue.path ?? [])
      .filter((key): key is string | number => typeof key === 'string' || typeof key === 'number')
      .join('.');
    records.push({
      path,
      code: typeof issue.code === 'string' ? issue.code : 'unknown',
      message: typeof issue.message === 'string' ? issue.message : String(issue.message),
    });
  }
  return records;
}

/**
 * Walks a collection schema into the field tree. The root is expected to be
 * an object (astro's frontmatter shape) — its children come back; any other
 * root (or no schema at all) degrades to a single root raw field, so every
 * collection opens in the builder regardless of its schema's shape.
 */
export function walkSchemaFields(schema: unknown, options: WalkOptions = {}): FormFieldNode[] {
  const root = walkNode(schema, '', 'frontmatter', options);
  return root.kind === 'group' ? root.children : [root];
}

interface Peeled {
  schema: unknown;
  required: boolean;
  initial: unknown;
  hasInitial: boolean;
}

/** Peels the widget-neutral wrappers, collecting optionality and defaults. */
function peelWrappers(schema: unknown): Peeled {
  let peeled: Peeled = { schema, required: true, initial: undefined, hasInitial: false };
  for (let guard = 0; guard < 32; guard += 1) {
    const def = zodDef(peeled.schema);
    if (def === null) break;
    if (def.type === 'optional' || def.type === 'nullable') {
      peeled = { ...peeled, schema: def.innerType, required: false };
      continue;
    }
    if (def.type === 'default') {
      peeled = {
        schema: def.innerType,
        required: false,
        initial: def.defaultValue,
        hasInitial: def.defaultValue !== undefined,
      };
      continue;
    }
    if (def.type === 'readonly' || def.type === 'catch') {
      peeled = { ...peeled, schema: def.innerType };
      continue;
    }
    break;
  }
  return peeled;
}

function walkNode(
  schema: unknown,
  path: string,
  label: string,
  options: WalkOptions,
): FormFieldNode {
  const peeled = peelWrappers(schema);
  const base = {
    path,
    label,
    required: peeled.required,
    ...(peeled.hasInitial ? { initial: peeled.initial } : {}),
  };

  if (options.isImage?.(peeled.schema)) {
    return { kind: 'image', ...base };
  }

  const def = zodDef(peeled.schema);
  if (def?.type === undefined) {
    return { kind: 'raw', reason: 'unwalkable', ...base };
  }

  switch (def.type) {
    case 'string':
      return { kind: 'string', ...base };
    case 'number':
      return { kind: 'number', ...base };
    case 'boolean':
      return { kind: 'boolean', ...base };
    case 'enum':
      return {
        kind: 'enum',
        options: Object.values((def.entries ?? {}) as Record<string, string | number>),
        ...base,
      };
    case 'object': {
      const shape = def.shape;
      if (typeof shape !== 'object' || shape === null) {
        return { kind: 'raw', reason: def.type, ...base };
      }
      const children = Object.entries(shape).map(([key, child]) =>
        walkNode(child, path === '' ? key : `${path}.${key}`, key, options),
      );
      return { kind: 'group', children, ...base };
    }
    case 'array': {
      const item = peelWrappers(def.element);
      const itemDef = zodDef(item.schema);
      const itemTypeEnum = itemDef?.type;
      const itemKind =
        itemTypeEnum === 'string' || itemTypeEnum === 'number' || itemTypeEnum === 'boolean'
          ? itemTypeEnum
          : itemTypeEnum === 'enum'
            ? 'enum'
            : null;
      if (itemKind === null) {
        return {
          kind: 'raw',
          reason: `${def.type}<${itemTypeEnum ?? 'unknown'}>`,
          ...base,
        };
      }
      return {
        kind: 'array',
        item: {
          kind: itemKind,
          ...(itemTypeEnum === 'enum'
            ? {
                options: Object.values((itemDef?.entries ?? {}) as Record<string, string | number>),
              }
            : {}),
        },
        ...base,
      };
    }
    default:
      // union, record, literal, date, pipe (transforms), intersection, tuple,
      // lazy, any, unknown… — the raw-field convention's whole catalogue
      return { kind: 'raw', reason: def.type, ...base };
  }
}

/**
 * The structural slice of a zod 4 `_zod.def` the walk consumes — typed to
 * keep the switch narrow; every field is optional because defs are open.
 */
interface ZodDef {
  type?: string;
  innerType?: unknown;
  defaultValue?: unknown;
  entries?: Record<string, unknown>;
  shape?: Record<string, unknown>;
  element?: unknown;
}

/** `_zod.def` when present, else null — zod 4's structural contract. */
function zodDef(schema: unknown): ZodDef | null {
  if (typeof schema !== 'object' || schema === null) return null;
  const holder = (schema as { _zod?: { def?: unknown } })._zod;
  if (typeof holder !== 'object' || holder === null) return null;
  if (typeof holder.def !== 'object' || holder.def === null) return null;
  return holder.def as ZodDef;
}
