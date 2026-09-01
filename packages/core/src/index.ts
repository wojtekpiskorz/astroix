/**
 * The workspace barrel for `@wojciechpiskorz/astroix-core` — the editing
 * domain extracted from the integration's `src/core` (#212, ADR-0010):
 * collections payloads, form trees, entry writing, the CSS indexer/matcher,
 * route resolution, and splice writes. The live integration still imports
 * through the compatibility re-exports at `src/core/*` until the retirement
 * gate; new code imports from here.
 */
export * from './collections';
export * from './entry-writer';
export * from './form-tree';
export * from './indexer';
export * from './matcher';
export * from './route-resolver';
export * from './splice-writer';
