import type { StoreApi, UseBoundStore } from 'zustand';
import {
  createWriteLoopStore,
  type WriteLoopStoreState,
} from '../../../editor/edit-drain/write-loop-store.ts';

/**
 * The Content write loop's feature-local store instance (#253, J3):
 * the SHARED edit drain/fence seam's store factory (ADR-0002
 * amendment 5 — the seam was born at the loop's second consumer,
 * #250/I2, which generalized this module's landed mechanics
 * mechanically; nothing here is Content-specific anymore). The mint is
 * strictly monotonic for the store's whole lifetime, so a post-reset
 * dispatch can never collide with a pre-reset one's stale settles.
 */

export const useContentWriteStore: UseBoundStore<StoreApi<WriteLoopStoreState>> =
  createWriteLoopStore();
