/**
 * The presentation surface (#219, lane C2, ADR-0002/ADR-0010): the retained
 * product widgets — the contract-shaped inspection, write-status, conflict,
 * validation, route, and selection presentation the replacement app shell
 * renders. Deliberately a SEPARATE export surface from the domain-deaf
 * barrel (`src/index.ts`): these widgets are domain-aware through TYPES
 * ONLY (the frozen B1/B2 contract shapes, carried type-only from
 * `packages/core` until `packages/protocol` lands); they take props and
 * callbacks — never fetchers, stores, elements, or runtime handles — so the
 * fetch/state/wiring ownership stays entirely with the host. The prop
 * taxonomy lives in `types.ts`; the contract derivation is pinned by
 * `contracts.test.ts`.
 */
export * from './array-rows';
export * from './content-form';
export * from './content-pane-state';
export * from './editor-header';
export * from './entry-tree';
export * from './field-widgets';
export * from './index-status';
export * from './range-chips';
export * from './rule-list';
export * from './schema-field';
export * from './shell-header';
export * from './types';
export * from './value-widgets';
export * from './write-status-badge';
