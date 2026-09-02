import {
  type CollectionsIndex,
  hasCandidateRoutes,
  pickNavigableCandidate,
} from '../../packages/core/src/route-resolver.ts';
import type { RouteResolutionFixture } from '../behavior-contracts/schema/inspection-contract.ts';

/**
 * The readiness legs' one shared composition (#214): builds the entry-
 * resolution table the way the frozen route-resolution contract froze it —
 * collections index, seen-set dedup, holder collections, candidate pick,
 * and the unrouted truth — through the RETAINED resolver. The surviving
 * contracts leg calls this over the frozen payloads and deep-compares the
 * result against the frozen rows.
 *
 * The composition's other copies (the B-lane capture pipeline in
 * `e2e/contract-oracle/live-capture.ts`, and the live-oracle comparison
 * leg's use) died at the retirement gate with the runtime they booted
 * (#215, lane A6) — this is now the only reader of the frozen
 * route-resolution rows. Whether the table itself belongs beside the
 * resolver in `packages/core` is a ticket question for the owner,
 * recorded on the PR.
 */

/** The walked collection listing the composition consumes (payload shape). */
interface CollectionListing {
  name: string;
  entries: ReadonlyArray<{ id: string }>;
}

/** The resolver's collections index over a served collections payload. */
export function buildCollectionsIndex(collections: readonly CollectionListing[]): CollectionsIndex {
  return Object.fromEntries(
    collections.map((collection) => [collection.name, collection.entries.map((entry) => entry.id)]),
  );
}

/** Recomputes the frozen route-resolution rows over the given payloads. */
export function recomputeEntryResolutions(
  collections: readonly CollectionListing[],
  routes: Parameters<typeof pickNavigableCandidate>[1],
): RouteResolutionFixture['entryResolutions'] {
  const collectionsIndex = buildCollectionsIndex(collections);
  const seen = new Set<string>();
  const rows: RouteResolutionFixture['entryResolutions'] = [];
  for (const collection of collections) {
    for (const entry of collection.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const hasCandidates = hasCandidateRoutes(entry.id, routes);
      rows.push({
        entryId: entry.id,
        holderCollections: Object.keys(collectionsIndex).filter((name) =>
          collectionsIndex[name]?.includes(entry.id),
        ),
        candidateUrl: pickNavigableCandidate(entry.id, routes, collectionsIndex),
        hasCandidateRoutes: hasCandidates,
        unrouted: !hasCandidates,
      });
    }
  }
  return rows;
}
