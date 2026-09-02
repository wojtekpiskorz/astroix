import type { AdapterError, SeamClass } from '../adapter-error';
import { observedShape, seamRejection } from '../adapter-error';

/**
 * The fail-closed content probes (#228, the `seam-readers.ts` idiom):
 * every version-sensitive Astro surface the content pass touches enters
 * through one of these readers, which verify the certified shape
 * (proven for `astro@7.2.10 + vite@8.2.2` by the #225 certification's
 * content leg) and throw `seam-rejected` — naming the seam, its class,
 * the expected shape, and a structural observed description — when the
 * observed shape differs. The pass never guesses a collection, entry,
 * or schema: an unknown shape is a compatibility event.
 *
 * Per-collection category failures (unknown loaders, schema factories)
 * are NOT seam rejections — they are the structured compatibility
 * diagnostics of `content-result.ts`, because the rest of the pass
 * stays valid without them. A seam rejection means the pass itself
 * cannot produce certified results.
 */

// ——— the seam inventory (named per docs/core-reuse.md's table) ———

export const SEAM_CONTENT_API = 'astro:content export getCollection()';
export const SEAM_ZOD_NAMESPACE = 'astro/zod root export';
export const SEAM_CONTENT_CONFIG = 'content config module src/content.config.ts collections export';
const SEAM_COLLECTION_ENTRIES = 'astro:content getCollection() entry export';

/**
 * The content config's fixed certified location — a fixed form, never a
 * path search; the runner import id, the byte-baseline read, and the
 * seam name all single-source through it.
 */
export const CONTENT_CONFIG_MODULE = 'src/content.config.ts';

/** The content seams an evaluation rejection can name — the constants' union, stated once. */
export type ContentSeamName =
  | typeof SEAM_CONTENT_API
  | typeof SEAM_ZOD_NAMESPACE
  | typeof SEAM_CONTENT_CONFIG;

/** Each evaluation-rejection seam's class — carried once, next to its name. */
const CONTENT_SEAM_CLASSES: Record<ContentSeamName, SeamClass> = {
  [SEAM_CONTENT_API]: 'public',
  [SEAM_ZOD_NAMESPACE]: 'public',
  [SEAM_CONTENT_CONFIG]: 'fail-closed private',
};

// ——— the structural likes handed to the pass ———

/** The `astro:content` slice the pass consumes. */
export interface ContentApiSeams {
  getCollection(name: string): Promise<unknown[]>;
}

/** The `astro/zod` slice the image stub needs (the same zod instance the project uses). */
export interface ZodNamespaceSeams {
  /** Builds the stub `image()` schemas from — the structural minimum the stub calls. */
  readonly string: () => { transform(fn: (value: string) => string): unknown };
}

/** One collection definition from the content config's `collections` record. */
export interface CollectionDefinitionSeams {
  readonly type?: unknown;
  readonly loader?: unknown;
  readonly schema?: unknown;
}

/** One entry's certified serving shape — the probed slice of `getCollection`'s output. */
export interface ServedEntry {
  readonly id: string;
  readonly filePath: string | null;
  readonly data: unknown;
  readonly body: string | null;
}

// ——— the probes ———
// Every rejection below is the single-homed `seamRejection` from
// `adapter-error.ts` (#311) — this file states no message template of
// its own.

/** `astro:content#getCollection` — public seam. */
export function readContentApi(moduleExports: unknown): ContentApiSeams {
  const getCollection = (moduleExports as { getCollection?: unknown })?.getCollection;
  if (typeof getCollection !== 'function') {
    throw seamRejection(
      SEAM_CONTENT_API,
      'public',
      'a function getCollection',
      observedShape(moduleExports),
    );
  }
  return { getCollection: getCollection as ContentApiSeams['getCollection'] };
}

/** A `getCollection` call rejecting for a declared collection — the same public seam. */
export function getCollectionRejection(collection: string, cause: unknown): AdapterError {
  return seamRejection(
    SEAM_CONTENT_API,
    'public',
    `getCollection(${collection}) to serve the declared collection`,
    'a getCollection rejection',
    cause,
  );
}

/**
 * The `astro/zod` namespace — the same zod instance the project uses
 * (core-reuse "Content"): the pass needs it only to build the certified
 * `image()` stub schemas a function-schema factory receives. Public seam.
 */
export function readZodNamespace(moduleExports: unknown): ZodNamespaceSeams {
  const string = (moduleExports as { string?: unknown })?.string;
  if (typeof string !== 'function') {
    throw seamRejection(
      SEAM_ZOD_NAMESPACE,
      'public',
      'a zod namespace with a string method',
      observedShape(moduleExports),
    );
  }
  return moduleExports as ZodNamespaceSeams;
}

/**
 * A content-seam module failing to evaluate or resolve through the
 * runner — the same seams the shape rejections name, with the
 * evaluation rejection kept as the cause and a structural observed
 * description (never the upstream message, which may carry project
 * paths).
 */
export function moduleEvaluationRejection(
  seam: ContentSeamName,
  expected: string,
  cause: unknown,
): AdapterError {
  return seamRejection(
    seam,
    CONTENT_SEAM_CLASSES[seam],
    expected,
    'a module evaluation rejection',
    cause,
  );
}

/**
 * The content config module's `collections` export — the certified
 * fixture form `src/content.config.ts`. Fail-closed private: the config
 * file and its export shape are Astro-internal contracts.
 */
export function readContentConfig(
  moduleExports: unknown,
): ReadonlyMap<string, CollectionDefinitionSeams> {
  const collections = (moduleExports as { collections?: unknown })?.collections;
  if (collections === null || typeof collections !== 'object' || Array.isArray(collections)) {
    throw seamRejection(
      SEAM_CONTENT_CONFIG,
      'fail-closed private',
      'a collections object export',
      observedShape(collections),
    );
  }
  const definitions = new Map<string, CollectionDefinitionSeams>();
  for (const [name, definition] of Object.entries(collections as Record<string, unknown>)) {
    if (definition === null || typeof definition !== 'object') {
      throw seamRejection(
        SEAM_CONTENT_CONFIG,
        'fail-closed private',
        `collection ${name} with an object definition`,
        observedShape(definition),
      );
    }
    definitions.set(name, definition as CollectionDefinitionSeams);
  }
  return definitions;
}

/**
 * The entries one `getCollection` call served — the array contract plus
 * the per-entry certified shape, probed together so the pass never
 * touches an unserved shape.
 */
export function readServedEntries(served: unknown): ServedEntry[] {
  if (!Array.isArray(served)) {
    throw seamRejection(
      SEAM_COLLECTION_ENTRIES,
      'public',
      'an array of entries',
      observedShape(served),
    );
  }
  return served.map(readEntryRecord);
}

/**
 * One entry as `getCollection` served it — the public serving shape,
 * probed per field. `filePath` must additionally be a project-relative
 * posix path (no absolute, no traversal, no backslash): a value that
 * would leave the project root is a shape drift, not a file to read.
 */
export function readEntryRecord(entry: unknown): ServedEntry {
  const candidate = entry as {
    id?: unknown;
    filePath?: unknown;
    data?: unknown;
    body?: unknown;
  } | null;
  if (
    typeof candidate?.id !== 'string' ||
    candidate.id.length === 0 ||
    candidate.data === null ||
    typeof candidate.data !== 'object' ||
    Array.isArray(candidate.data)
  ) {
    throw seamRejection(
      SEAM_COLLECTION_ENTRIES,
      'public',
      'an entry with a string id and an object data',
      observedShape(entry),
    );
  }
  const filePath = readEntryFilePath(candidate.filePath);
  const body = typeof candidate.body === 'string' ? candidate.body : null;
  return { id: candidate.id, filePath, data: candidate.data, body };
}

function readEntryFilePath(filePath: unknown): string | null {
  if (filePath === undefined) return null;
  if (
    typeof filePath !== 'string' ||
    filePath.length === 0 ||
    filePath.startsWith('/') ||
    filePath.includes('\\') ||
    filePath.split('/').includes('..')
  ) {
    throw seamRejection(
      SEAM_COLLECTION_ENTRIES,
      'public',
      'a project-relative posix filePath',
      typeof filePath === 'string' ? 'a non-relative filePath spelling' : observedShape(filePath),
    );
  }
  return filePath;
}
