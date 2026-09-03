import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { create } from 'zustand';
import { sameSessionPair } from './session-gate.ts';

/**
 * The edit session's state slots (#241, G2): the four edit-side fields
 * of the commit-time reset's clearing list (ADR-0006 §5 / ADR-0002
 * amendment 3) — held resource grants, undo state, scheduled
 * debounces, and pending mutations. These are SLOTS, not the shared
 * edit drain/fence seam: admission, scheduling, fencing, and draining
 * are that seam's to build (ADR-0002 amendment 5, born at its second
 * consumer); the shell only owns the fields' presence, their session
 * binding, and their ordered clearing at transition commit.
 *
 * Grant and undo records are deliberately opaque carriers: the wire
 * representation of a `ResourceGrant` is opaque by protocol, and the
 * shell never interprets what it holds — it counts and clears.
 */

/** One opaque resource grant the session holds (ADR-0006 §6; the browser never interprets it). */
export interface HeldGrant {
  readonly token: string;
}

/** One opaque undo record on the session's undo state. */
export interface UndoRecord {
  readonly token: string;
}

/** One scheduled debounce (the future seam's scheduling writes these; the reset drops them). */
export interface ScheduledDebounce {
  readonly key: string;
  readonly dueAtMs: number;
}

/** One tracked pending mutation (accepted, not yet terminal). */
export interface PendingMutation {
  readonly key: string;
}

interface EditSessionStoreState {
  /** The pair this store is bound at; `null` between sessions (post-reset) — every gated setter no-ops. */
  session: SessionRef | null;
  grants: readonly HeldGrant[];
  undo: readonly UndoRecord[];
  debounces: readonly ScheduledDebounce[];
  pendingMutations: readonly PendingMutation[];
  /** Binds the store at one exact pair (the provider, at session adoption). */
  bindSession(ref: SessionRef): void;
  holdGrant(actor: SessionRef, grant: HeldGrant): void;
  pushUndo(actor: SessionRef, record: UndoRecord): void;
  /** Schedules one debounce; a same-key scheduling replaces the earlier one. */
  scheduleDebounce(actor: SessionRef, debounce: ScheduledDebounce): void;
  trackPendingMutation(actor: SessionRef, mutation: PendingMutation): void;
  /** The reset's clearing step: wipes the fields AND unbinds — post-clear writes cannot land. */
  clear(): void;
}

export const useEditSessionStore = create<EditSessionStoreState>((set, get) => ({
  session: null,
  grants: [],
  undo: [],
  debounces: [],
  pendingMutations: [],
  bindSession: (ref) => set({ session: ref }),
  holdGrant: (actor, grant) => {
    if (sameSessionPair(actor, get().session)) set({ grants: [...get().grants, grant] });
  },
  pushUndo: (actor, record) => {
    if (sameSessionPair(actor, get().session)) set({ undo: [...get().undo, record] });
  },
  scheduleDebounce: (actor, debounce) => {
    if (!sameSessionPair(actor, get().session)) return;
    set({ debounces: [...get().debounces.filter((d) => d.key !== debounce.key), debounce] });
  },
  trackPendingMutation: (actor, mutation) => {
    if (sameSessionPair(actor, get().session))
      set({ pendingMutations: [...get().pendingMutations, mutation] });
  },
  clear: () => set({ session: null, grants: [], undo: [], debounces: [], pendingMutations: [] }),
}));
