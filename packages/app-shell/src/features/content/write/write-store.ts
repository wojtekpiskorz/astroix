import type { StoreApi, UseBoundStore } from 'zustand';
import {
  createWriteLoopStore,
  type WriteLoopStoreState,
} from '../../../editor/edit-drain/write-loop-store.ts';
import { registerFeatureStoreReset } from '../../../state/feature-store-registry.ts';

/**
 * The Content write loop's feature-local store instance (#253, J3):
 * the SHARED edit drain/fence seam's store factory (ADR-0002
 * amendment 5 — the seam was born at the loop's second consumer,
 * #250/I2, which generalized this module's landed mechanics
 * mechanically; nothing here is Content-specific anymore). The mint is
 * strictly monotonic for the store's whole lifetime, so a post-reset
 * dispatch can never collide with a pre-reset one's stale settles.
 *
 * Registered with the shell's commit-time reset registry (#372, ruled
 * 2026-09-04): the ordered clear-stores step runs the machine's own
 * `reset` event — the mint survives it by the factory's law.
 */

export const useContentWriteStore: UseBoundStore<StoreApi<WriteLoopStoreState>> =
  createWriteLoopStore();

// The #372 registration: module scope, beside the store's creation —
// the sequencer's clear-stores step clears this store at every commit.
registerFeatureStoreReset('content:write', () => useContentWriteStore.getState().reset());
