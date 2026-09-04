import { pickNavigableCandidate } from '../../../../../core/src/route-resolver.ts';
import { useShell } from '../../../app-shell/shell-context.ts';
import type { ActiveEntryView } from '../../../presentation/types.ts';
import { useAppStore } from '../../../state/app-store.ts';
import type { ContentDiscoveryQuery } from '../api.ts';
import { navigateCanvasFrame } from './canvas-navigation.ts';
import { type NavigationFeedback, useContentNavigationStore } from './navigation-store.ts';

/**
 * The Content vertical's navigation slice (#251, J1): what an entry
 * click does — resolve the entry's natural project URL EXCLUSIVELY
 * through the E5 routes payload and navigate the same-origin canvas to
 * it.
 *
 * Route resolution is the frozen contract's own pure algorithm — core's
 * `pickNavigableCandidate` (the `route-resolution` behavior contract,
 * frozen over the canonical fixture) over the E5 payload's patterns,
 * segments, and renders: a unique — or plurality-uniform — render-aware
 * candidate selects, taking the most specific pattern; anything else
 * selects NOTHING (the heuristic never picks wrong, it picks nothing).
 * No project path or URL is constructed from any other source: not
 * from `filePath`, not from entry data, never a client guess — a
 * pathname exists for navigation only when E5's patterns produce it.
 *
 * The canvas navigation itself rides the seam in
 * {@link ./canvas-navigation.ts} (the frame's own same-origin location
 * API — the address control's path). The open entry also lands in the
 * shell app store's `activeEntry` slot (the cross-vertical summary,
 * session-gated by the store's own actor check).
 */

/** The navigation slice the panel consumes. */
export interface EntryNavigation {
  /** The open entry — the tree row that highlights. */
  readonly activeEntry: ActiveEntryView | null;
  /** The last entry-open gesture's outcome — the feedback surface's truth. */
  readonly feedback: NavigationFeedback;
  /** One entry-open gesture: select, resolve through E5, navigate the canvas. */
  openEntry(collection: string, entryId: string): void;
}

/** Resolves the canvas's shared origin — the shell document's own (the project origin). */
function canvasOrigin(): string {
  const origin = globalThis.location?.origin;
  if (origin === undefined) {
    throw new Error('entry navigation needs a document origin (the project origin)');
  }
  return origin;
}

/**
 * The navigation hook over one discovery query's derived truth. The
 * query comes in as an argument — one subscription, one derivation,
 * shared with the panel that renders it.
 */
export function useEntryNavigation(discovery: ContentDiscoveryQuery): EntryNavigation {
  const { session } = useShell();
  const activeEntry = useContentNavigationStore((state) => state.activeEntry);
  const feedback = useContentNavigationStore((state) => state.feedback);
  const setActiveEntry = useContentNavigationStore((state) => state.setActiveEntry);
  const reportNoRoute = useContentNavigationStore((state) => state.reportNoRoute);
  const reportCanvasUnavailable = useContentNavigationStore(
    (state) => state.reportCanvasUnavailable,
  );
  const reportNavigated = useContentNavigationStore((state) => state.reportNavigated);
  const setShellActiveEntry = useAppStore((state) => state.setActiveEntry);

  const openEntry = (collection: string, entryId: string): void => {
    setActiveEntry({ collection, entryId });
    setShellActiveEntry(session.ref, { entryId });
    const routes = discovery.routes;
    // No E5 truth, no navigation: the panel only offers entry rows in
    // the ready state (routes bound), so this guard is the total-function
    // tail — an unresolved click stays selected, never guessed.
    if (routes === null) return;
    const candidate = pickNavigableCandidate(entryId, routes, discovery.collectionsIndex);
    if (candidate === null) {
      reportNoRoute(entryId);
      return;
    }
    // The candidate is a bare pathname from E5's pattern space; the
    // absolute URL resolves against the shell document's own origin —
    // the exact origin the canvas shares (G3's law).
    const url = new URL(candidate, canvasOrigin()).href;
    const outcome = navigateCanvasFrame(url);
    if (outcome === 'canvas-unavailable') {
      reportCanvasUnavailable();
      return;
    }
    reportNavigated(entryId, candidate);
  };

  return { activeEntry, feedback, openEntry };
}
