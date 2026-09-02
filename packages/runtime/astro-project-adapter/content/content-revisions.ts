import { createHash } from 'node:crypto';
import type { ContentCollectionResult, ContentCompatibilityDiagnostic } from './content-result';

/**
 * The content revisions (#228): deterministic SHA-256 digests over the
 * typed truth each level of the pass serves — the entry baseline
 * (computed in `entry-baselines.ts` from the file bytes), the
 * collection truth, and the whole pass. The digest inputs are the
 * constructed-in-fixed-key-order result objects themselves, so the
 * serialization is canonical by construction: identical truth ⇒
 * identical revision across passes; changed truth ⇒ changed revision.
 * The zod projection (`entry.data`) is deliberately NOT an input — the
 * file bytes and the schema walk cover the truth it derives from.
 */

const COLLECTION_REVISION_TAG = 'astroix/content-collection@1';
const PASS_REVISION_TAG = 'astroix/content-pass@1';

function digest(tag: string, value: unknown): string {
  return createHash('sha256')
    .update(`${tag}\n${JSON.stringify(value)}`)
    .digest('hex');
}

/** The collection revision — over entry ids, file baselines, and the schema truth. */
export function collectionRevision(collection: ContentCollectionResult): string {
  return digest(COLLECTION_REVISION_TAG, {
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
  collections: readonly ContentCollectionResult[],
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
