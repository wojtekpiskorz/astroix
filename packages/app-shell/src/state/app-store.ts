import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { create } from 'zustand';
import type { SelectionDescriptor } from './selection.ts';
import { sameSessionPair } from './session-gate.ts';

/**
 * The shell's small app store (#241, G2; ADR-0002: "a small app-level
 * store holds cross-vertical state"): the cross-vertical session state
 * the commit-time reset must clear — live selection, canvas state, and
 * the active entry (ADR-0006 §5 / ADR-0002 amendment 3's list). The
 * canvas lane (#242, G3) gave the selection and canvas slots their real
 * shapes — the canvas component writes them, the shell binds and
 * clears them; the content lanes grow the rest.
 *
 * The second belt lives in the setters: every write carries the ACTING
 * pair and lands only while the store is bound at that exact pair — a
 * stale response or late event calling with a moved-past pair (or after
 * the reset unbound the store) writes nothing.
 */

/** The clicked-element identity slot — the re-matchable descriptor (#242, G3; CONTEXT.md "selection"). */
export type ShellSelection = SelectionDescriptor;

/** The canvas's observed origin state — the fail-closed editing gate's input (the spec's user story 5). */
export type CanvasOriginState = 'project' | 'external';

/** The canvas slot's session state — the live page the canvas frame last observed. */
export interface CanvasSessionState {
  /** The observed natural URL; `null` while the canvas is off the project origin (unreadable by law). */
  readonly url: string | null;
  readonly origin: CanvasOriginState;
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
  /**
   * Drops the live selection without touching the binding — the canvas's
   * fail-closed off-origin action (#242: inspection disabled until the
   * canvas returns). Clearing carries no pair: the ordered commit-time
   * reset is the authority that empties this slot across sessions, and a
   * drop is idempotent with it — a late off-origin observation landing
   * after a transition can at worst clear a fresh session's empty-or-
   * stale selection, never repopulate anything.
   */
  clearSelection(): void;
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
  clearSelection: () => set({ selection: null }),
  clear: () => set({ session: null, selection: null, canvas: null, activeEntry: null }),
}));
