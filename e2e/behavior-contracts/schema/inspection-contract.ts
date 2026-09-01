import { z } from 'zod';
import type { FormFieldNode } from '../../../packages/core/src/form-tree.ts';

/**
 * The inspection behavior-contract schema (#216, lane B1, ADR-0010): the
 * versioned description of what the retired integration's inspection
 * surfaces produced over the canonical plain fixture — CSS index payloads
 * (edit-truth joined with effective selectors), Content collections (raw
 * truth vs zod projection), schema fields, route payloads, and
 * route-resolution results. The frozen corpus under
 * `e2e/behavior-contracts/inspection/` is validated against this schema,
 * and the capture suite (`e2e/contracts-inspection.spec.ts`) re-runs the
 * disposable oracle and asserts the same bytes — that is the freeze.
 *
 * Vocabulary is CONTEXT.md's: index payload, effective selector, raw truth,
 * zod projection, unrouted entry, candidate route, route resolution. The
 * replacement runtime is judged against these contracts, not against the
 * old implementation.
 *
 * The schema deliberately encodes the identity invariants the corpus must
 * preserve rather than normalize away (#216 AC-3): project-relative file
 * paths (never absolute — AC-4), the cid-carrying compiled form of scoped
 * selectors per strategy, code-unit collection order, and the renders-space
 * invariants of route payloads. `packages/protocol` is a future lane; this
 * file is the interim home named by the ticket.
 */

/** Semver `contractVersion` stamped on every frozen fixture. */
export const CONTRACT_VERSION = '1.0.0';

const contractVersion = z.string().regex(/^\d+\.\d+\.\d+$/, 'contractVersion must be semver');

/**
 * A project-relative posix path — the confinement shape every file field
 * carries (AC-4: no absolute paths, no traversal, no scheme).
 */
const projectRelativeFile = z
  .string()
  .min(1)
  .refine(
    (file) =>
      !file.startsWith('/') &&
      !file.includes('\\') &&
      !file.includes('://') &&
      !file.split('/').includes('..') &&
      !file.startsWith('node_modules/'),
    { message: 'file must be a project-relative posix path' },
  );

/**
 * Character offsets of a rule in its source file, end-exclusive — the
 * splice-writer's edit window. Start must precede end.
 */
const sourceRange = z
  .object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
  .refine((range) => range.start < range.end, { message: 'range.start must precede range.end' });

/** A pathname-only URL — scheme/host/port presence is an AC-4 artifact. */
const pathnameUrl = z
  .string()
  .min(1)
  .refine((url) => url.startsWith('/') && !url.includes('://') && !url.includes('@'), {
    message: 'url must be a bare pathname — no scheme, host, port, or vite handle',
  });

// --- CSS index payload (the module-graph hybrid join) ---

/** One served index-payload record: an edit-truth rule plus its join result. */
const cssIndexRecord = z.object({
  /** Selector text verbatim from source — source space, no cid synthesis. */
  selector: z.string().min(1),
  file: projectRelativeFile,
  range: sourceRange,
  /** One-based selector line in `file` (the rule list shows it). */
  line: z.number().int().positive(),
  /** Nearest `@media` ancestor condition, or null at the top level. */
  media: z.string().nullable(),
  /** True for rules from a scoped `<style>` block (the compiler applies the cid). */
  scoped: z.boolean(),
  /** Module-graph style-block index (`{file}.astro?astro&type=style&index={N}`), or null (`is:inline`). */
  styleBlockIndex: z.number().int().nonnegative().nullable(),
  /**
   * The compiled selector form as the canvas DOM matches it — scoped rules
   * carry the `data-astro-cid-*` attribute per the project's
   * scopedStyleStrategy; null when the block's module is not in the graph
   * (not loaded on the current route), and always null for global rules.
   */
  effectiveSelector: z.string().nullable(),
});

/**
 * The scopedStyleStrategy variants the corpus freezes — the testing-doctrine
 * seam of docs/spec.md (Web host: selector-engine behavior is the source of
 * truth, `[data-astro-cid-*]` under the default `attribute` strategy,
 * `:where(...)` only when configured).
 */
export const scopedStyleStrategy = z.enum(['attribute', 'where']);

/**
 * The compiled cid token each strategy's scoped selectors carry, as observed
 * on the certified astro pair: the default `attribute` strategy emits the
 * `data-astro-cid-*` attribute form; `where` wraps the scoped CLASS
 * (`.astro-<hash>`, the same path-derived hash) in a zero-specificity
 * `:where()`.
 */
export const CID_FORM: Record<z.infer<typeof scopedStyleStrategy>, string> = {
  attribute: '[data-astro-cid-',
  where: ':where(.astro-',
};

/** The frozen CSS index payload for one strategy run of the oracle. */
export const cssIndexFixtureSchema = z
  .object({
    contractVersion,
    kind: z.literal('css-index'),
    scopedStyleStrategy,
    records: z.array(cssIndexRecord).min(1),
  })
  .superRefine((fixture, ctx) => {
    for (const [index, record] of fixture.records.entries()) {
      if (!record.scoped && record.effectiveSelector !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['records', index, 'effectiveSelector'],
          message: 'global rules never join the module graph — effectiveSelector must be null',
        });
      }
      if (record.scoped && record.effectiveSelector !== null) {
        const cidForm = CID_FORM[fixture.scopedStyleStrategy];
        if (!record.effectiveSelector.includes(cidForm)) {
          ctx.addIssue({
            code: 'custom',
            path: ['records', index, 'effectiveSelector'],
            message: `a joined scoped selector under the ${fixture.scopedStyleStrategy} strategy must carry ${cidForm}…) — selector identity is not normalizable`,
          });
        }
      }
    }
  });

// --- Content collections (zod projection) ---

/** One collection entry as served — `data` is the zod projection (unknown shape by schema right). */
const collectionEntry = z.object({
  /** Slugified source path (glob-loader id), e.g. `2024/post`. */
  id: z.string().min(1),
  /** Root-relative posix source path, or null for store entries without one. */
  filePath: projectRelativeFile.nullable(),
  /** Parsed frontmatter — astro's zod output with defaults filled, transforms applied. */
  data: z.unknown(),
  /** Raw markdown body, or null for data-only entries. */
  body: z.string().nullable(),
});

const collectionRecord = z.object({
  name: z.string().min(1),
  hasSchema: z.boolean(),
  entries: z.array(collectionEntry),
});

/** The frozen collections payload — code-unit order is served behavior, not presentation. */
export const collectionsFixtureSchema = z
  .object({
    contractVersion,
    kind: z.literal('collections'),
    collections: z.array(collectionRecord).min(1),
  })
  .superRefine((fixture, ctx) => {
    const codeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    for (const [index, collection] of fixture.collections.entries()) {
      const next = fixture.collections[index + 1];
      if (next !== undefined && codeUnit(collection.name, next.name) >= 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['collections', index + 1, 'name'],
          message: 'collections are name-sorted by code unit — order is not normalizable',
        });
      }
      for (const [entryIndex, entry] of collection.entries.entries()) {
        const nextEntry = collection.entries[entryIndex + 1];
        if (nextEntry !== undefined && codeUnit(entry.id, nextEntry.id) >= 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['collections', index, 'entries', entryIndex + 1, 'id'],
            message: 'entries are id-sorted by code unit — order is not normalizable',
          });
        }
      }
    }
  });

// --- Content schema fields (the form-tree walk) ---

const fieldBase = {
  /** Dotted path into the entry's data (`cta.label`); `''` = the whole frontmatter. */
  path: z.string(),
  /** Last path segment, human-facing. */
  label: z.string().min(1),
  /** False when any optional/nullable/default wrapper was peeled. */
  required: z.boolean(),
  /** The schema's `defaultValue` when present (zod fills it into the projection too). */
  initial: z.unknown().optional(),
};

const enumOptions = z.array(z.union([z.string(), z.number()]));

// Recursive by the group node — the explicit annotation (typed by the
// legacy walk's own node type, the contract this freezes) is what lets the
// self-reference resolve.
const fieldNodeUnion: z.ZodType<FormFieldNode> = z.discriminatedUnion('kind', [
  z.object({ ...fieldBase, kind: z.literal('string') }),
  z.object({ ...fieldBase, kind: z.literal('number') }),
  z.object({ ...fieldBase, kind: z.literal('boolean') }),
  z.object({ ...fieldBase, kind: z.literal('enum'), options: enumOptions }),
  z.object({ ...fieldBase, kind: z.literal('image') }),
  z.object({
    ...fieldBase,
    kind: z.literal('array'),
    item: z.object({
      kind: z.enum(['string', 'number', 'boolean', 'enum']),
      options: enumOptions.optional(),
    }),
  }),
  z.object({
    ...fieldBase,
    kind: z.literal('group'),
    children: z.array(z.lazy(() => fieldNodeUnion)),
  }),
  z.object({ ...fieldBase, kind: z.literal('raw'), reason: z.string().min(1) }),
]);

/** The frozen schema-field walks, one per collection (schema-less degrades to a root raw field). */
export const contentSchemasFixtureSchema = z.object({
  contractVersion,
  kind: z.literal('content-schemas'),
  schemas: z
    .array(
      z.object({
        collection: z.string().min(1),
        fields: z.array(fieldNodeUnion).min(1),
      }),
    )
    .min(1)
    .superRefine((schemas, ctx) => {
      const names = schemas.map((schema) => schema.collection);
      if (new Set(names).size !== names.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['schemas'],
          message: 'one schema walk per collection — duplicate collections are not contract shape',
        });
      }
    }),
});

// --- Raw truth (the entry file's own bytes through GET /__astroix/file) ---

/** The frozen raw-truth reads: file bytes anchored against the zod projection. */
export const rawTruthFixtureSchema = z.object({
  contractVersion,
  kind: z.literal('raw-truth'),
  reads: z
    .array(
      z.object({
        file: projectRelativeFile,
        contents: z.string().refine((text) => text.startsWith('---\n'), {
          message: 'raw truth of a content entry is its frontmatter-fenced bytes',
        }),
      }),
    )
    .min(1)
    .superRefine((reads, ctx) => {
      const files = reads.map((read) => read.file);
      if (new Set(files).size !== files.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['reads'],
          message: 'one read per file — duplicate reads are not contract shape',
        });
      }
    }),
});

// --- Route payloads (the astro:routes:resolved projection + enumeration) ---

const routeSegmentPart = z.object({
  content: z.string(),
  dynamic: z.boolean(),
  spread: z.boolean(),
});

const routeInfo = z
  .object({
    /** Astro route pattern — identity and display; resolution reads `segments`. */
    pattern: z.string().min(1).startsWith('/'),
    /** Astro's own parse of the pattern: parts per segment. */
    segments: z.array(z.array(routeSegmentPart)),
    /** Param names as Astro reports them (`...slug` for a rest param). */
    params: z.array(z.string()),
    /** Per-route rendering mode — always present, synchronous from the hook. */
    rendering: z.enum(['prerendered', 'on-demand']),
    /**
     * The param values the route actually renders — present only on
     * prerendered single-param routes with positively-succeeded enumeration;
     * absent = unknown, `[]` = knowably renders nothing.
     */
    renders: z.array(z.string()).optional(),
  })
  .superRefine((route, ctx) => {
    if (
      route.renders !== undefined &&
      !(route.params.length === 1 && route.rendering === 'prerendered')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['renders'],
        message:
          'renders is the getStaticPaths enumeration space of prerendered single-param routes only — its presence elsewhere is a normalized-away rendering state',
      });
    }
  });

/** The frozen routes payload. */
export const routesFixtureSchema = z.object({
  contractVersion,
  kind: z.literal('routes'),
  routes: z
    .array(routeInfo)
    .min(1)
    .superRefine((routes, ctx) => {
      const patterns = routes.map((route) => route.pattern);
      if (new Set(patterns).size !== patterns.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes'],
          message: 'a pattern is route identity — duplicates are not contract shape',
        });
      }
    }),
});

// --- Route resolution (the pure URL↔entry bridge over the captured payload) ---

/** The entry a canvas URL plausibly renders — the active entry. */
const activeEntry = z.object({
  collection: z.string().min(1),
  entryId: z.string().min(1),
});

/** Reverse resolution + the unrouted predicate for one entry id. */
const entryResolution = z
  .object({
    entryId: z.string().min(1),
    /** Every collection holding the id — more than one is the ambiguity that keeps clicks silent. */
    holderCollections: z.array(z.string().min(1)).min(1),
    /** The candidate-route URL entry→canvas navigation picks, or null (silence). */
    candidateUrl: pathnameUrl.nullable(),
    /** Whether any single-param route actually renders the id (render-aware candidates). */
    hasCandidateRoutes: z.boolean(),
    /** The sidebar's unrouted-entry marker truth: no route actually renders the entry. */
    unrouted: z.boolean(),
  })
  .superRefine((resolution, ctx) => {
    if (resolution.unrouted === resolution.hasCandidateRoutes) {
      ctx.addIssue({
        code: 'custom',
        path: ['unrouted'],
        message:
          'unrouted is the negation of hasCandidateRoutes — the marker never fires on unknown',
      });
    }
  });

/** Forward resolution for one probed canvas URL, with the rendering state it met. */
const urlProbe = z.object({
  url: pathnameUrl,
  /** What the managed dev server rendered: 200 for a rendered page, 404 for the unknown-route state. */
  httpStatus: z.union([z.literal(200), z.literal(404)]),
  resolved: activeEntry.nullable(),
});

/** The frozen route-resolution results computed by the pure core module over the captured payloads. */
export const routeResolutionFixtureSchema = z.object({
  contractVersion,
  kind: z.literal('route-resolution'),
  entryResolutions: z
    .array(entryResolution)
    .min(1)
    .superRefine((resolutions, ctx) => {
      const ids = resolutions.map((resolution) => resolution.entryId);
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['entryResolutions'],
          message: 'one resolution row per entry id — duplicates are not contract shape',
        });
      }
    }),
  urlProbes: z.array(urlProbe).min(1),
});

// --- The corpus manifest: every frozen fixture name → its schema ---

export type CssIndexFixture = z.infer<typeof cssIndexFixtureSchema>;
export type CollectionsFixture = z.infer<typeof collectionsFixtureSchema>;
export type ContentSchemasFixture = z.infer<typeof contentSchemasFixtureSchema>;
export type RawTruthFixture = z.infer<typeof rawTruthFixtureSchema>;
export type RoutesFixture = z.infer<typeof routesFixtureSchema>;
export type RouteResolutionFixture = z.infer<typeof routeResolutionFixtureSchema>;

export const fixtureSchemas = {
  'css-index.attribute.json': cssIndexFixtureSchema,
  'css-index.where.json': cssIndexFixtureSchema,
  'collections.json': collectionsFixtureSchema,
  'content-schemas.json': contentSchemasFixtureSchema,
  'raw-truth.json': rawTruthFixtureSchema,
  'routes.json': routesFixtureSchema,
  'route-resolution.json': routeResolutionFixtureSchema,
} as const;

export type FixtureName = keyof typeof fixtureSchemas;
