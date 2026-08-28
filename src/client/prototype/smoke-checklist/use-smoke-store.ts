// PROTOTYPE (issue #46) — throwaway, never ships. In-memory only: the smoke
// run lives for one browser session; no persistence by design (prototype
// rule). Shared across variants so flipping A/B/C keeps progress.
import { create } from 'zustand';
import { SMOKE_STEPS } from './smoke-steps';

interface SmokeChecklistState {
  done: Record<string, boolean>;
  note: Record<string, string>;
  toggle: (id: string) => void;
  setNote: (id: string, value: string) => void;
  reset: () => void;
}

export const useSmokeStore = create<SmokeChecklistState>()((set) => ({
  done: {},
  note: {},
  toggle: (id) => set((state) => ({ done: { ...state.done, [id]: !state.done[id] } })),
  setNote: (id, value) => set((state) => ({ note: { ...state.note, [id]: value } })),
  reset: () => set({ done: {}, note: {} }),
}));

export function verifiedCount(done: Record<string, boolean>): number {
  return SMOKE_STEPS.filter((step) => done[step.id]).length;
}

/** The Copy-report payload: a static markdown prompt ready to paste into an
 * issue or an agent session. */
export function buildSmokeReport(): string {
  const { done, note } = useSmokeStore.getState();
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const lines: string[] = [
    `## Manual smoke report — ${stamp} UTC`,
    '',
    `- URL: ${window.location.origin}${window.location.pathname}`,
    `- UA: ${navigator.userAgent}`,
    '- Source: in-chrome smoke checklist (prototype, issue #46)',
    '',
    '### Steps',
  ];
  const outstanding: string[] = [];
  for (const step of SMOKE_STEPS) {
    const ok = done[step.id] === true;
    if (!ok) outstanding.push(step.id);
    lines.push(`- [${ok ? 'x' : ' '}] ${step.id} — ${step.title}`);
    const text = note[step.id]?.trim();
    if (text) lines.push(`  - note: ${text}`);
  }
  lines.push(
    '',
    '### Result',
    `${verifiedCount(done)}/${SMOKE_STEPS.length} verified${
      outstanding.length > 0 ? ` · outstanding: ${outstanding.join(', ')}` : ' · all clear'
    }.`,
    '',
    '<!-- paste into a GitHub issue; an agent session picks it up from there -->',
  );
  return lines.join('\n');
}

export async function copySmokeReport(): Promise<string> {
  const report = buildSmokeReport();
  await navigator.clipboard.writeText(report);
  return report;
}
