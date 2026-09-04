import type { StoreApi, UseBoundStore } from 'zustand';
import {
  createWriteLoopStore,
  type WriteLoopStoreState,
} from '../../../editor/edit-drain/write-loop-store.ts';
import { registerFeatureStoreReset } from '../../../state/feature-store-registry.ts';

/**
 * The CSS write loop's feature-local store instance (#250, I2): the
 * shared edit drain/fence seam's store factory (ADR-0002 amendment 5 —
 * this loop is the seam's second consumer, its chartered birth). The
 * mint is strictly monotonic for the store's whole lifetime, so a
 * post-reset dispatch can never collide with a pre-reset one's stale
 * settles; one loop instance serves every CSS edit in the document
 * (the serialized dispatch discipline — one mutation in flight).
 */

export const useCssWriteStore: UseBoundStore<StoreApi<WriteLoopStoreState>> =
  createWriteLoopStore();

// The #372 registration: module scope, beside the store's creation —
// the sequencer's clear-stores step quiets this machine at every
// commit, the mint surviving by the factory's law.
registerFeatureStoreReset('css:write', () => useCssWriteStore.getState().reset());
