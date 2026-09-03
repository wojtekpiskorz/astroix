import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { create } from 'zustand';
import { sameSessionPair } from './session-gate.ts';

/**
 * The shell's small app store (#241, G2; ADR-0002: "a small app-level
 * store holds cross-vertical state"): the cross-vertical session state
 * the commit-time reset must clear — live selection, canvas state, and
 * the active entry (ADR-0006 §5 / ADR-0002 amendment 3's list). The
 * canvas and content lanes grow the real interactions; the shell owns
 * the fields, their session binding, and their clearing.
 *
 * The second belt lives in the setters: every write carries the ACTING
 * pair and lands only while the store is bound at that exact pair — a
 * stale response or late event calling with a moved-past pair (or after
 * the reset unbound the store) writes nothing.
 */

/** The clicked-element descriptor slot — the canvas/matcher lanes own the real shape; the shell only clears it. */
export interface ShellSelection {
  readonly tag: string;
  readonly elementId: string | null;
}

/** The canvas slot's session state — the live page the canvas frame shows. */
export interface CanvasSessionState {
  readonly url: string;
}

/** The active-entry slot — the entry open in the content editor (CONTEXT.md "active entry"). */
export interface ActiveEntry {
  readonly entryId: string;
}

interface AppStoreState {
  /** The pair this store is bound at; `null` between sessions (post-reset) — every gated setter no-ops. */
  session: SessionRef | null;
  selection: ShellSelection | null;
  canvas: CanvasSessionState | null;
  activeEntry: ActiveEntry | null;
  /** Binds the store at one exact pair (the provider, at session adoption). */
  bindSession(ref: SessionRef): void;
  setSelection(actor: SessionRef, selection: ShellSelection): void;
  setCanvasState(actor: SessionRef, canvas: CanvasSessionState): void;
  setActiveEntry(actor: SessionRef, entry: ActiveEntry): void;
  /** The reset's clearing step: wipes the fields AND unbinds — post-clear writes cannot land. */
  clear(): void;
}

export const useAppStore = create<AppStoreState>((set, get) => ({
  session: null,
  selection: null,
  canvas: null,
  activeEntry: null,
  bindSession: (ref) => set({ session: ref }),
  setSelection: (actor, selection) => {
    if (sameSessionPair(actor, get().session)) set({ selection });
  },
  setCanvasState: (actor, canvas) => {
    if (sameSessionPair(actor, get().session)) set({ canvas });
  },
  setActiveEntry: (actor, activeEntry) => {
    if (sameSessionPair(actor, get().session)) set({ activeEntry });
  },
  clear: () => set({ session: null, selection: null, canvas: null, activeEntry: null }),
}));
