import { create } from 'zustand';

/** In-memory only by design: a smoke run lives for one browser session —
 * persistence is out of scope for the fold-in (#61). */
interface SmokeState {
  done: Record<string, boolean>;
  note: Record<string, string>;
  toggle: (id: string) => void;
  setNote: (id: string, value: string) => void;
}

export const useSmokeStore = create<SmokeState>()((set) => ({
  done: {},
  note: {},
  toggle: (id) => set((state) => ({ done: { ...state.done, [id]: !state.done[id] } })),
  setNote: (id, value) => set((state) => ({ note: { ...state.note, [id]: value } })),
}));
