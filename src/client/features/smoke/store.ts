import { create } from 'zustand';
import type { SmokeStep } from './smoke-steps';

/** In-memory only by design: a smoke run lives for one browser session —
 * persistence is out of scope for the fold-in (#61). Keys are step ids, so
 * an unknown step id is unrepresentable at this seam (the pure report
 * builder still accepts arbitrary records and filters — its test documents
 * that boundary). */
interface SmokeState {
  done: Partial<Record<SmokeStep['id'], boolean>>;
  note: Partial<Record<SmokeStep['id'], string>>;
  toggle: (id: SmokeStep['id']) => void;
  setNote: (id: SmokeStep['id'], value: string) => void;
}

export const useSmokeStore = create<SmokeState>()((set) => ({
  done: {},
  note: {},
  toggle: (id) => set((state) => ({ done: { ...state.done, [id]: !state.done[id] } })),
  setNote: (id, value) => set((state) => ({ note: { ...state.note, [id]: value } })),
}));
