import { createHash } from 'node:crypto';
import type { ContentCollectionResult, ContentCompatibilityDiagnostic } from './content-result';

/**
 * The content revisions (#228): deterministic SHA-256 digests over the
 * typed truth each level of the pass serves — the entry baseline
 * (computed in `entry-baselines.ts` from the file bytes), the content
 * config module's own bytes (the schema-semantics input: defaults,
 * refinements, and transform bodies change served behavior without
 * changing the walked field tree, so the config's byte baseline is a
 * digest input at every level it can affect), the collection truth,
 * and the whole pass. The digest inputs are constructed-in-fixed-key
 * -order result objects, so the serialization is canonical by
 * construction: identical truth ⇒ identical revision across passes;
 * changed truth ⇒ changed revision. The zod projection
 * (`entry.data`) is deliberately NOT an input — the file bytes, the
 * config bytes, and the schema walk cover the truth it derives from.
 */

// @2: the config byte baseline joined the input set — the input-set tag
// version-bumps so a pre-@2 collection revision can never collide with one.
const COLLECTION_REVISION_TAG = 'astroix/content-collection@2';
const PASS_REVISION_TAG = 'astroix/content-pass@1';

function digest(tag: string, value: unknown): string {
  return createHash('sha256')
    .update(`${tag}\n${JSON.stringify(value)}`)
    .digest('hex');
}

/** The collection truth a revision digests — everything but the revision itself. */
export type CollectionTruth = Omit<ContentCollectionResult, 'revision'>;

/**
 * The collection revision — over the config byte baseline, entry ids,
 * file baselines, and the schema truth. The config input is the WHOLE
 * config module's bytes: schema semantics for every collection live in
 * that one file, so a config edit bumps every collection's revision —
 * over-invalidation by construction, never under-invalidation.
 */
export function collectionRevision(configBaseline: string, collection: CollectionTruth): string {
  return digest(COLLECTION_REVISION_TAG, {
    configBaseline,
    name: collection.name,
    schema: { declared: collection.schema.declared, fields: collection.schema.fields },
    entries: collection.entries.map((entry) => ({
      id: entry.id,
      filePath: entry.filePath,
      revision: entry.revision,
    })),
  });
}

/** The pass revision — over every collection revision and diagnostic, name-ordered. */
export function passRevision(
  collections: readonly Readonly<ContentCollectionResult>[],
  diagnostics: readonly ContentCompatibilityDiagnostic[],
): string {
  return digest(PASS_REVISION_TAG, {
    collections: collections.map((collection) => ({
      name: collection.name,
      revision: collection.revision,
    })),
    diagnostics,
  });
}
