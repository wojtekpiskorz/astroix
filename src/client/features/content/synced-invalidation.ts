import type { QueryClient } from '@tanstack/react-query';
import type { CustomEventMap } from 'vite/types/customEvent';
import { useChromeStore } from '../../store';
import { COLLECTIONS_KEY, SCHEMA_KEY } from './api';

/**
 * Which watcher leg a `astroix:content-synced` push carries — derived from
 * the wire declaration in `vite-env.d.ts`, the single source (the sender's
 * half is `ContentSyncLeg` in `src/node/content-signal.ts`).
 */
export type ContentSyncLeg = CustomEventMap['astroix:content-synced']['leg'];

/**
 * The bounded wait for a canvas load that never comes (#155): the reload
 * broadcast can be missed, or the iframe's `load` can fire before the push
 * lands — the sidebar must still refresh, just late. In principle a reload
 * slower than the bound re-opens the race below; both failure modes
 * self-heal on the next content signal, and no observed pipeline (loader
 * debounce 500 ms + dev render) comes near it.
 */
const NO_LOAD_FALLBACK_MS = 3_000;

/** Invalidate the content caches now — the shared immediate path (srcDir leg, core's own signal). */
export function invalidateContentCaches(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: COLLECTIONS_KEY });
  void queryClient.invalidateQueries({ queryKey: SCHEMA_KEY });
}

/**
 * Sequenced invalidation of the content caches (#155): on the loader leg
 * the chrome holds the invalidation until its own canvas-load signal bumps
 * — the iframe's `load` event fires only after the reloaded document is
 * served, so a fresh-runner refetch can no longer race the post-commit
 * re-render (the #133 verified failure: the two evaluations racing leave
 * the canvas serving the pre-commit store for good; the 1 s server-side
 * render grace this replaces only assumed the render had finished). Any
 * load after the arm satisfies the wait — a user navigation is a render
 * too, and after the commit every render reads post-commit data.
 *
 * The srcDir leg stays immediate: its refetch lands well before the
 * loader's 500 ms-debounced store write and the reload — the race needs
 * the refetch concurrent with the render. Concurrent loader pushes arm
 * concurrent waits; they settle on the same load and the invalidations
 * dedupe in flight.
 */
export function invalidateOnContentSynced(queryClient: QueryClient, leg: ContentSyncLeg): void {
  if (leg !== 'loader') {
    invalidateContentCaches(queryClient);
    return;
  }
  const armSeq = useChromeStore.getState().canvasLoad?.seq ?? 0;
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unsubscribe();
    invalidateContentCaches(queryClient);
  };
  const unsubscribe = useChromeStore.subscribe((state) => {
    if ((state.canvasLoad?.seq ?? 0) > armSeq) settle();
  });
  const timer = setTimeout(settle, NO_LOAD_FALLBACK_MS);
}
