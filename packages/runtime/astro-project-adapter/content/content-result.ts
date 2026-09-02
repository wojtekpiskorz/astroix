import type { FormFieldNode, ValidationIssueRecord } from '@wojciechpiskorz/astroix-core';

/**
 * The typed content-inspection result (#228, ADR-0005 `inspect()` content
 * family): one fresh-runner pass over the composition server returns
 * collections, entries, schemas, and revisions — and nothing else. There
 * is no module handle, no store handle, no absolute path, and no
 * client-selected anything on this surface; `filePath` values are the
 * project-relative posix paths the project's own content layer serves.
 *
 * `revision` here is the adapter's per-resource content revision — the
 * SHA-256 baseline of the resource's truth (ADR-0006 §6's revision
 * contract for existing resources, the freshness fact edit-authority
 * grants bind). Monotonic revision *ordering* is layered above the
 * adapter by the session/worker lanes, which own state across passes;
 * the adapter's contract is deterministic strength: identical truth ⇒
 * identical revision, changed truth ⇒ changed revision.
 */

/**
 * One inspected entry. `data` is the zod projection (the rendered data
 * the project's own content layer served — defaults filled, transforms
 * applied; display-only truth per CONTEXT.md), `revision` the SHA-256 of
 * the entry source file's bytes — null for store entries without a file.
 */
export interface ContentEntryResult {
  /** Slugified source id as the project's loader produced it (`2024/post`). */
  readonly id: string;
  /** Project-relative posix source path, or null for store entries without one. */
  readonly filePath: string | null;
  /** The zod projection — the project's actual parse output, verbatim. */
  readonly data: unknown;
  /** Raw markdown body, or null for data-only entries. */
  readonly body: string | null;
  /**
   * SHA-256 hex over the entry file's bytes at pass time (the grant
   * baseline); null when the entry has no source file.
   */
  readonly revision: string | null;
  /**
   * The project's actual schema validation of the entry's raw truth
   * (frontmatter parsed from the same bytes), through the project's own
   * zod instance — the managed project's schema behavior, never guessed
   * field metadata. Null when there is no schema or no file to validate.
   */
  readonly issues: readonly ValidationIssueRecord[] | null;
}

/** One inspected collection's schema result: presence plus the walked field tree. */
export interface ContentSchemaResult {
  /** Whether the project's content config declared a schema (the corpus `hasSchema`). */
  readonly declared: boolean;
  /**
   * The form-tree walk (core `walkSchemaFields`) over the project's
   * actual schema instance. Schema-less collections degrade to a single
   * root raw field — the preserved every-collection-opens contract; a
   * declared-but-unwalkable zod shape degrades the same way, node by
   * node, inside the walk.
   */
  readonly fields: readonly FormFieldNode[];
}

/** One certified-inspected collection — entries, schema, and its revision. */
export interface ContentCollectionResult {
  readonly name: string;
  /** Entries id-sorted by code unit — the frozen served order. */
  readonly entries: readonly ContentEntryResult[];
  readonly schema: ContentSchemaResult;
  /**
   * SHA-256 hex over the collection's typed truth: entry ids + file
   * baselines + the schema declaration and field walk. Bumps when any
   * entry file, the schema, or the entry set changes.
   */
  readonly revision: string;
}

/**
 * A compatibility diagnostic for one declared collection that failed a
 * certified-category contract (#228: unknown loaders, schema factories,
 * or unsupported shapes fail with a diagnostic rather than partial
 * equivalence). Structured and sanitized like a seam rejection — the
 * observed side is a structural shape description, never values or
 * paths. The collection is NOT returned among `collections`: no support
 * claim is made for it.
 */
export interface ContentCompatibilityDiagnostic {
  readonly code: ContentCompatibilityCode;
  /** The declared collection the diagnostic names. */
  readonly collection: string;
  /** The certified-category contract that failed. */
  readonly expected: string;
  /** Structural observed-shape description (the `observedShape` idiom). */
  readonly observed: string;
}

/** The closed diagnostic code set — one entry per certified-category boundary. */
export const CONTENT_COMPAT_CODES = [
  /** The loader is not the certified glob-loader category (`astro/loaders#glob()`). */
  'unknown-loader',
  /** The collection is not a content-layer collection (legacy or live shapes). */
  'unsupported-collection-shape',
  /** A schema factory whose invocation did not yield the project's zod schema. */
  'unknown-schema-factory',
  /** A schema that is not a zod instance per the project's own contract. */
  'unknown-schema-shape',
] as const;

export type ContentCompatibilityCode = (typeof CONTENT_COMPAT_CODES)[number];

/** One content inspection pass's typed result. */
export interface ContentInspectionResult {
  /** Certified-inspected collections, name-sorted by code unit. */
  readonly collections: readonly ContentCollectionResult[];
  /**
   * Compatibility diagnostics, collection-name-sorted — one per declared
   * collection outside the certified categories.
   */
  readonly diagnostics: readonly ContentCompatibilityDiagnostic[];
  /**
   * SHA-256 hex over the whole pass's typed truth (collection revisions
   * + diagnostics). The pass-level change signal: identical truth ⇒
   * identical revision across passes.
   */
  readonly revision: string;
}
