import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { create } from 'zustand';
import { registerFeatureStoreReset } from '../../state/feature-store-registry.ts';
import { sameSessionPair } from '../../state/session-gate.ts';

/**
 * The CSS vertical's undo state (#250, I2): the generation-local stack
 * of inverse splices — one entry per landed write, each carrying the
 * exact bytes that restore it. Undo is a WRITE like any other: the
 * popped inverse dispatches through the same grant-bound auto-write
 * loop (the CURRENT grant authorizes it; the server re-validates the
 * baseline), never a client-side file trick.
 *
 * Generation-local by construction: the stack is bound at one exact
 * session pair — a push through a different pair clears it first (an
 * A-to-B-to-A document never sees the old generation's undo), and the
 * explicit `clear` is the conflict-reload and revocation path's (the
 * entries' baselines died with the world they were computed against).
 * The transition commit needs no registration: the ordered reset
 * replaces the whole document (the J2/J3 #372-precedent self-gate),
 * and the shell's edit-session store holds the opaque accounting
 * (`pushUndo`) the reset's clearing list observably drops.
 */

/** One landed write's inverse — enough to restore the bytes and prove them. */
export interface CssUndoEntry {
  /** The entry's identity: the file plus the splice's bounds. */
  readonly key: string;
  /** The file the inverse writes — the anchor the dispatch resolves. */
  readonly file: string;
  /** The range the landed write left its replacement at — the inverse's range. */
  readonly range: { readonly start: number; readonly end: number };
  /** The bytes that restore the file (the landed write's replaced slice). */
  readonly replacement: string;
  /** What the inverse will find there (the landed write's replacement) — the byte-proof. */
  readonly replaced: string;
}

interface CssUndoState {
  /** The pair this stack is bound at; `null` when cleared. */
  session: SessionRef | null;
  entries: readonly CssUndoEntry[];
  /** Binds the stack at one exact pair — a different pair clears first. */
  bind(actor: SessionRef): void;
  push(actor: SessionRef, entry: CssUndoEntry): void;
  /** The next entry to undo, peeled off the stack. */
  peek(): CssUndoEntry | null;
  /** Drops the peeled entry (the caller dispatches the inverse). */
  pop(actor: SessionRef): void;
  /** The conflict-reload / revocation clear — the baselines died. */
  clear(): void;
}

export const useCssUndoStore = create<CssUndoState>((set, get) => ({
  session: null,
  entries: [],
  bind: (actor) => {
    if (!sameSessionPair(actor, get().session)) set({ session: actor, entries: [] });
  },
  push: (actor, entry) => {
    if (!sameSessionPair(actor, get().session)) return;
    set((state) => ({ entries: [...state.entries, entry] }));
  },
  peek: () => get().entries.at(-1) ?? null,
  pop: (actor) => {
    if (!sameSessionPair(actor, get().session)) return;
    set((state) => ({ entries: state.entries.slice(0, -1) }));
  },
  clear: () => set({ session: null, entries: [] }),
}));

/** The stack's depth for the UI's enablement — `0` is the disabled truth. */
export function undoDepth(): number {
  return useCssUndoStore.getState().entries.length;
}

// The #372 registration: module scope, beside the store's creation —
// the sequencer's clear-stores step clears this stack at every commit
// (a trivial set; the pair-bind belt stays for the same-document window).
registerFeatureStoreReset('css:undo', () => useCssUndoStore.getState().clear());
