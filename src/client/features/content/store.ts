import { create } from 'zustand';
import type { ActiveEntry } from '../../../core/route-resolver';

interface ContentState {
  /** The entry open in the content editor (glossary: active entry). */
  activeEntry: ActiveEntry | null;
  /**
   * The entry a reverse navigation is taking the canvas to: armed by the
   * entry click, consumed by the next canvas resolution — a forward match
   * confirms the navigation, a miss keeps the clicked entry (the
   * form-only fallback).
   */
  pendingVerify: ActiveEntry | null;
  /** A manual list click: the entry opens first, navigation is secondary. */
  selectEntry: (entry: ActiveEntry) => void;
  /** Arms the forward-match verification for a reverse navigation. */
  armReverseVerify: (entry: ActiveEntry) => void;
  /**
   * A canvas resolution (URL → entry) lands here. Plain navigations adopt
   * it — silence clears the entry; an armed reverse navigation is verified
   * instead: a match reselects the same entry, a miss keeps the manual
   * pick, and the arm clears either way.
   */
  applyCanvasResolution: (resolved: ActiveEntry | null) => void;
}

export const useContentStore = create<ContentState>()((set) => ({
  activeEntry: null,
  pendingVerify: null,
  selectEntry: (entry) => set({ activeEntry: entry }),
  armReverseVerify: (entry) => set({ pendingVerify: entry }),
  applyCanvasResolution: (resolved) =>
    set((state) => {
      if (state.pendingVerify !== null) {
        // the manual pick stays: on a successful forward match it equals
        // `resolved` already, on a miss it is the form-only fallback
        return { pendingVerify: null };
      }
      return { activeEntry: resolved };
    }),
}));
