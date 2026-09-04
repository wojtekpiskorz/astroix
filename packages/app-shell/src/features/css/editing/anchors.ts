import type { ResourceGrant, SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { create } from 'zustand';
import { sameSessionPair } from '../../../state/session-gate.ts';

/**
 * The CSS write loop's per-file anchors (#250, I2): the CURRENT write
 * truth for every file the served payload enriched — the raw text the
 * splice planner proves ranges against, and the grant the next plan
 * echoes. Two sources note anchors, in the only order that stays
 * honest: the served facts (the freshest inspection's grant —
 * issuance supersedes the session's previous grant for the target, so
 * the served note always wins when it arrives last) and a committed
 * settle's local derivation (the pure splice oracle over the served
 * raw plus the follow-on grant — the anchor that lets consecutive
 * auto-writes continue while the refresh converges; the server's own
 * baseline check is the proof, never this cache).
 *
 * Session-bound like every edit-side store: a note through a
 * different pair never lands (the J2/J3 #372-precedent self-gate —
 * the ordered reset replaces the document, this belt covers the
 * window before it does).
 */

/** One file's write anchor — the byte anchor plus the authority to write it. */
export interface CssAnchor {
  readonly raw: string;
  readonly grant: ResourceGrant;
}

interface CssAnchorState {
  /** The pair these anchors are bound at; `null` when cleared. */
  session: SessionRef | null;
  readonly anchors: ReadonlyMap<string, CssAnchor>;
  bind(actor: SessionRef): void;
  /** Notes one file's anchor — a served fact or a committed derivation. */
  note(actor: SessionRef, file: string, anchor: CssAnchor): void;
  /** The conflict-reload / revocation clear. */
  clear(): void;
}

export const useCssAnchorStore = create<CssAnchorState>((set, get) => ({
  session: null,
  anchors: new Map(),
  bind: (actor) => {
    if (!sameSessionPair(actor, get().session)) set({ session: actor, anchors: new Map() });
  },
  note: (actor, file, anchor) => {
    if (!sameSessionPair(actor, get().session)) return;
    set((state) => {
      const anchors = new Map(state.anchors);
      anchors.set(file, anchor);
      return { anchors };
    });
  },
  clear: () => set({ session: null, anchors: new Map() }),
}));
