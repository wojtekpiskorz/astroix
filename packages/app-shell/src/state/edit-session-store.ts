import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { create } from 'zustand';
import { sameSessionPair } from './session-gate.ts';

/**
 * The edit session's state slots (#241, G2): the two edit-side fields
 * of the commit-time reset's clearing list (ADR-0006 §5 / ADR-0002
 * amendment 3) — held resource grants and undo state. These are SLOTS,
 * not the shared edit drain/fence seam: admission, scheduling, fencing,
 * and draining are that seam's to build (ADR-0002 amendment 5, born at
 * its second consumer); the shell only owns the fields' presence, their
 * session binding, and their ordered clearing at transition commit. The
 * clearing list's "scheduled debounces" never became a slot here: the
 * seam landed with the scheduler as loop-local accounting
 * (`pendingKeys()` — one source of truth, #250's ruling), so the
 * pauses die at the document's death and the hook's unmount `clear()`,
 * with no shell mirror to drift. "Pending mutations" met the same
 * reconcile (#406, deleted 2026-09-04 — the K2 ruling): the slot and
 * its `trackPendingMutation` never had a product writer (the marker's
 * `pending=` read zero everywhere real), and the honest accounting
 * already lives in the seam's machine — the write loops track their
 * own queue state and report through their own status surfaces, so a
 * shell-visible count would be a second book that can only drift.
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

interface EditSessionStoreState {
  /** The pair this store is bound at; `null` between sessions (post-reset) — every gated setter no-ops. */
  session: SessionRef | null;
  grants: readonly HeldGrant[];
  undo: readonly UndoRecord[];
  /** Binds the store at one exact pair (the provider, at session adoption). */
  bindSession(ref: SessionRef): void;
  holdGrant(actor: SessionRef, grant: HeldGrant): void;
  pushUndo(actor: SessionRef, record: UndoRecord): void;
  /** The reset's clearing step: wipes the fields AND unbinds — post-clear writes cannot land. */
  clear(): void;
}

export const useEditSessionStore = create<EditSessionStoreState>((set, get) => ({
  session: null,
  grants: [],
  undo: [],
  bindSession: (ref) => set({ session: ref }),
  holdGrant: (actor, grant) => {
    if (sameSessionPair(actor, get().session)) set({ grants: [...get().grants, grant] });
  },
  pushUndo: (actor, record) => {
    if (sameSessionPair(actor, get().session)) set({ undo: [...get().undo, record] });
  },
  clear: () => set({ session: null, grants: [], undo: [] }),
}));
