/**
 * The unit tier's shared selection fixture (#242 review round 2: the
 * `aSelection()` helper carried in three test files, absorbed into one
 * small module per tier). Test-only — the store, reset, and provider
 * unit tests import this; no product code touches it.
 */

/** One selection descriptor — the #242 real shape of the store's selection slot. */
export function aSelection() {
  return {
    tag: 'h1',
    id: null,
    classes: ['hero-title'],
    scopeAttributes: ['data-astro-cid-fixture'],
  };
}
