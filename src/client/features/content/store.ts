import { create } from 'zustand';
import type { ActiveEntry } from '../../../core/route-resolver';
import type { CanvasLoad } from '../../store';

/**
 * The armed reverse navigation (#71, #140): the entry it opens and the URL
 * whose load verifies it. Consumed by the next canvas resolution — a
 * forward match confirms the navigation, a miss keeps the clicked entry
 * (the form-only fallback).
 */
interface PendingVerify {
  entry: ActiveEntry;
  targetUrl: string;
}

interface ContentState {
  /** The entry open in the content editor (glossary: active entry). */
  activeEntry: ActiveEntry | null;
  /** The reverse navigation awaiting its verifying load. */
  pendingVerify: PendingVerify | null;
  /**
   * The canvas load the last resolution applied. Each load resolves at
   * most once: the tracker effect re-runs on remounts and refetches, but a
   * load seq already applied is a no-op — no navigation, no resolution.
   */
  appliedLoadSeq: number;
  /**
   * Tree folders rendered collapsed (#111), keyed by collection-scoped path
   * ('blog/2024'). Chrome-only UI state per ADR-0002 — it lives here so the
   * choices survive tab roundtrips like the active entry does.
   */
  collapsedFolders: Set<string>;
  /** A manual list click: the entry opens first, navigation is secondary. */
  selectEntry: (entry: ActiveEntry) => void;
  /** Toggles one tree folder between collapsed and open. */
  toggleFolder: (key: string) => void;
  /** Arms the forward-match verification for a reverse navigation to `targetUrl`. */
  armReverseVerify: (entry: ActiveEntry, targetUrl: string) => void;
  /**
   * A canvas resolution (URL → entry) lands here, tagged with its load.
   * A new load seq is applied exactly once: plain navigations adopt the
   * resolution — silence clears the entry; an armed reverse navigation is
   * verified instead — a match reselects the same entry, a miss keeps the
   * manual pick, and the arm clears either way. The one exception: an armed
   * load for a URL other than the armed navigation's target (#140 — the
   * navigation was superseded, its load never fired) is a plain navigation
   * and adopts the resolution. A stale seq (remount, StrictMode's second
   * pass, refetch identity change) changes nothing.
   */
  applyCanvasResolution: (resolved: ActiveEntry | null, load: CanvasLoad) => void;
}

/** Pathname equality against the chrome's origin — the arm's load-vs-target comparator. */
function samePathname(target: string, loadUrl: string): boolean {
  return (
    new URL(loadUrl, window.location.href).pathname ===
    new URL(target, window.location.href).pathname
  );
}

export const useContentStore = create<ContentState>()((set) => ({
  activeEntry: null,
  pendingVerify: null,
  appliedLoadSeq: 0,
  collapsedFolders: new Set<string>(),
  selectEntry: (entry) => set({ activeEntry: entry }),
  toggleFolder: (key) =>
    set((state) => {
      // a fresh Set per toggle: zustand readers compare by identity
      const collapsed = new Set(state.collapsedFolders);
      if (!collapsed.delete(key)) collapsed.add(key);
      return { collapsedFolders: collapsed };
    }),
  armReverseVerify: (entry, targetUrl) => set({ pendingVerify: { entry, targetUrl } }),
  applyCanvasResolution: (resolved, load) =>
    set((state) => {
      if (load.seq <= state.appliedLoadSeq) return state;
      if (state.pendingVerify !== null) {
        if (!samePathname(state.pendingVerify.targetUrl, load.url)) {
          return { pendingVerify: null, activeEntry: resolved, appliedLoadSeq: load.seq };
        }
        // the manual pick stays: on a successful forward match it equals
        // `resolved` already, on a miss it is the form-only fallback
        return { pendingVerify: null, appliedLoadSeq: load.seq };
      }
      return { activeEntry: resolved, appliedLoadSeq: load.seq };
    }),
}));
