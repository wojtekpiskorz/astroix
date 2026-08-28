import { create } from 'zustand';
import type { StepId } from './smoke-steps';

/** In-memory only by design: a smoke run lives for one browser session —
 * persistence is out of scope for the fold-in (#61). Keys are the StepId
 * union derived from SMOKE_STEPS, so an unknown step id does not compile at
 * this seam (the pure report builder still accepts arbitrary records and
 * filters — its test documents that boundary). */
interface SmokeState {
  done: Partial<Record<StepId, boolean>>;
  note: Partial<Record<StepId, string>>;
  toggle: (id: StepId) => void;
  setNote: (id: StepId, value: string) => void;
}

export const useSmokeStore = create<SmokeState>()((set) => ({
  done: {},
  note: {},
  toggle: (id) => set((state) => ({ done: { ...state.done, [id]: !state.done[id] } })),
  setNote: (id, value) => set((state) => ({ note: { ...state.note, [id]: value } })),
}));
