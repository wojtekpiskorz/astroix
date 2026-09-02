import type { CollectionDefinitionSeams, ZodNamespaceSeams } from './content-probes';
import type { ContentCompatibilityCode, ContentCompatibilityDiagnostic } from './content-result';

/**
 * Certified-category schema loading (#228): the loader/type
 * classification and the schema resolution for one collection
 * definition, executed with the managed project's actual schema
 * behavior — the schema instances are the project's own (its content
 * config evaluated through the fresh runner), function schemas are
 * invoked exactly the way Astro invokes them (`schema({ image })`, with
 * an `image()` stub built from the project's own zod via `astro/zod`),
 * and validation is the resolved instance's own parse. Field metadata is
 * never guessed: the walk (core `walkSchemaFields`) reads the instance
 * structurally, and unsupported zod nodes degrade to raw fields — the
 * preserved every-collection-opens contract. What is NOT certifiable —
 * an unknown loader, a legacy/live collection shape, a factory that does
 * not yield the project's zod — is a compatibility diagnostic, never a
 * partial-equivalence claim.
 */

/** The glob loader's own name at the certified pin (`astro/loaders#glob()`). */
const CERTIFIED_LOADER_NAME = 'glob-loader';

/** The collection type `defineCollection` stamps when a loader is present. */
const CONTENT_LAYER_TYPE = 'content_layer';

/** The structural slice of a zod 4 schema both arms of the resolution require. */
export interface ZodSchemaLike {
  safeParseAsync(data: unknown): Promise<{
    success: boolean;
    error?: {
      issues?: Iterable<{ path?: readonly PropertyKey[]; code?: unknown; message: unknown }>;
    };
  }>;
}

/** The certified result of resolving one collection's schema. */
export interface LoadedCollectionSchema {
  /** False when the config declared no schema (the schema-less category). */
  readonly declared: boolean;
  /** The project's actual schema instance — null only when `declared` is false. */
  readonly schema: ZodSchemaLike | null;
  /** Membership test marking the stub `image()` instances during the walk. */
  readonly isImage: (candidate: unknown) => boolean;
}

/** The resolution outcome: loaded, or the diagnostic that names why not. */
export type SchemaLoadOutcome =
  | { readonly outcome: 'loaded'; readonly loaded: LoadedCollectionSchema }
  | { readonly outcome: 'unsupported'; readonly diagnostic: ContentCompatibilityDiagnostic };

/** The classification outcome: the certified category, or the diagnostic that names why not. */
export type CollectionCategoryOutcome =
  | { readonly outcome: 'certified' }
  | { readonly outcome: 'unsupported'; readonly diagnostic: ContentCompatibilityDiagnostic };

/**
 * Classifies one collection definition against the certified categories:
 * a content-layer collection (`type: 'content_layer'`, the stamp
 * `defineCollection` adds when a loader is present) carrying the
 * certified glob loader. Legacy loader-less shapes, live collections,
 * and third-party loaders are compatibility diagnostics — #228's
 * migration policy makes no support claim beyond the certified fixture
 * categories.
 */
export function classifyCollectionCategory(
  name: string,
  definition: CollectionDefinitionSeams,
): CollectionCategoryOutcome {
  if (definition.type !== CONTENT_LAYER_TYPE) {
    return {
      outcome: 'unsupported',
      diagnostic: compatDiagnostic(name, 'unsupported-collection-shape', {
        expected:
          'a content-layer collection (type content_layer, produced by defineCollection with a loader)',
        observed: observedType(definition.type),
      }),
    };
  }
  const loader = definition.loader as { name?: unknown; load?: unknown } | null | undefined;
  if (
    loader === null ||
    loader === undefined ||
    typeof loader !== 'object' ||
    loader.name !== CERTIFIED_LOADER_NAME ||
    typeof loader.load !== 'function'
  ) {
    return {
      outcome: 'unsupported',
      diagnostic: compatDiagnostic(name, 'unknown-loader', {
        expected: 'the certified glob loader (an object with name glob-loader and a load function)',
        observed: observedType(loader),
      }),
    };
  }
  return { outcome: 'certified' };
}

/**
 * Resolves one collection's schema with the project's actual behavior:
 * the instance arm takes the declared schema as-is; the factory arm
 * invokes it exactly as Astro does (`schema({ image })`), substituting
 * the stub `image()` (a `z.string().transform` from the project's own
 * zod — Astro's own content-layer stub shape) whose instances the walk
 * recognizes by membership. A factory that rejects or does not yield the
 * project's zod is a compatibility diagnostic, never a guess.
 */
export async function loadCollectionSchema(
  name: string,
  definition: CollectionDefinitionSeams,
  zod: ZodNamespaceSeams | null,
): Promise<SchemaLoadOutcome> {
  const declared = definition.schema;
  if (declared === undefined) {
    return { outcome: 'loaded', loaded: { declared: false, schema: null, isImage: neverImage } };
  }
  if (typeof declared === 'function') {
    if (zod === null) {
      // The pass only imports astro/zod when a factory exists; reaching
      // here without it is a pass-orchestration bug, not a project shape.
      throw new Error('schema factory present but the zod namespace was not resolved');
    }
    return resolveFactorySchema(name, declared as (context: unknown) => unknown, zod);
  }
  if (!isZodSchema(declared)) {
    return {
      outcome: 'unsupported',
      diagnostic: compatDiagnostic(name, 'unknown-schema-shape', {
        expected:
          'the declared schema to be a zod schema instance (with _zod.def and safeParseAsync)',
        observed: observedType(declared),
      }),
    };
  }
  return { outcome: 'loaded', loaded: { declared: true, schema: declared, isImage: neverImage } };
}

async function resolveFactorySchema(
  name: string,
  factory: (context: unknown) => unknown,
  zod: ZodNamespaceSeams,
): Promise<SchemaLoadOutcome> {
  const stubs = new Set<unknown>();
  let invocationError: unknown;
  let resolved: unknown;
  try {
    resolved = factory({
      image: () => {
        // Astro's own content-layer image() stub is z.string().transform:
        // the frontmatter value is (and stays) a path string through
        // validation; membership in `stubs` is what marks the field for
        // the walk. Built from the project's own zod — the same instance
        // the surrounding schema parses with.
        const stub = zod.string().transform((value) => value);
        stubs.add(stub);
        return stub;
      },
    });
  } catch (error) {
    invocationError = error;
  }
  if (invocationError !== undefined || !isZodSchema(resolved)) {
    return {
      outcome: 'unsupported',
      diagnostic: compatDiagnostic(name, 'unknown-schema-factory', {
        expected:
          'the schema factory to accept the schema context and return the project zod schema',
        observed:
          invocationError !== undefined
            ? 'a schema factory invocation rejection'
            : observedType(resolved),
      }),
    };
  }
  return {
    outcome: 'loaded',
    loaded: { declared: true, schema: resolved, isImage: (candidate) => stubs.has(candidate) },
  };
}

/**
 * Whether a value satisfies the project's own zod-instance contract:
 * the `_zod.def` holder (Astro's own "Invalid Zod schema" check reads
 * the same marker) plus the async safe-parse the content layer's
 * validation behavior calls.
 */
function isZodSchema(value: unknown): value is ZodSchemaLike {
  if (value === null || typeof value !== 'object') return false;
  const holder = (value as { _zod?: { def?: unknown } })._zod;
  if (typeof holder !== 'object' || holder === null || typeof holder.def !== 'object') {
    return false;
  }
  return typeof (value as ZodSchemaLike).safeParseAsync === 'function';
}

function neverImage(): boolean {
  return false;
}

/** One structured compatibility diagnostic — structural observed, never values. */
export function compatDiagnostic(
  collection: string,
  code: ContentCompatibilityCode,
  shape: { expected: string; observed: string },
): ContentCompatibilityDiagnostic {
  return { code, collection, expected: shape.expected, observed: shape.observed };
}

/** A structural type description for the unsupported shapes (type facts, never values). */
export function observedType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'function') return 'function';
  const type = typeof value;
  if (type !== 'object') return `typeof ${type}`;
  return `object with own properties ${Object.keys(value as Record<string, unknown>)
    .slice(0, 5)
    .join(', ')}`;
}
