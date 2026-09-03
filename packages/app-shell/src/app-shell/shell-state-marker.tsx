import type { QueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { create } from 'zustand';
import { sessionQueryCount } from '../query/session-query-cache.ts';
import { useAppStore } from '../state/app-store.ts';
import { useEditSessionStore } from '../state/edit-session-store.ts';
import { shellStoreSnapshot } from '../state/shell-stores.ts';
import { useShell } from './shell-context.ts';
import type { ShellResetStep } from './shell-reset.ts';

/**
 * The shell's honest state surface (#241, G2): one line — `shell-state`
 * — reporting the reset-clearable session state (query cache, the seven
 * store fields) plus the reset trace. It exists so the transition-commit
 * contract is observable: the reset writes it SYNCHRONOUSLY as each
 * clearing step completes, before the navigation step runs — the E2E
 * legs intercept the navigation request and read this element in the
 * still-alive old document, which is the ordering proof (state removal
 * BEFORE location replacement).
 *
 * The live half is React-rendered (the trace in a tiny zustand store so
 * both the record and the per-session clear re-render it); the reset
 * half is a direct DOM write (React state cannot commit synchronously
 * ahead of `location.replace`). Both halves format through the same
 * function, so the text never disagrees with the truth it reports.
 */

interface ResetTraceState {
  readonly steps: readonly ShellResetStep[];
  record(step: ShellResetStep): void;
  clear(): void;
}

/** The completed clearing steps — module state: one shell per document, one reset per transition. */
const useResetTraceStore = create<ResetTraceState>((set) => ({
  steps: [],
  record: (step) =>
    set((state) => (state.steps.includes(step) ? state : { steps: [...state.steps, step] })),
  clear: () => set({ steps: [] }),
}));

/** The trace as a marker string — `none` until a clearing step completes. */
export function shellResetTrace(): string {
  const steps = useResetTraceStore.getState().steps;
  return steps.length === 0 ? 'none' : steps.join(',');
}

/** Clears the trace at session adoption — a fresh session's marker starts honestly at `none`. */
export function clearShellResetTrace(): void {
  useResetTraceStore.getState().clear();
}

/** One marker line's full state. */
export interface ShellStateMarkerState {
  readonly queries: number;
  readonly selection: boolean;
  readonly canvas: boolean;
  readonly activeEntry: boolean;
  readonly grants: number;
  readonly undo: number;
  readonly debounces: number;
  readonly pendingMutations: number;
  /** `none`, or the ordered trace of completed clearing steps. */
  readonly reset: string;
}

/** Formats the one marker line — the single format both the render and the reset write share. */
export function formatShellState(state: ShellStateMarkerState): string {
  const flag = (value: boolean): string => (value ? '1' : '0');
  return (
    `queries=${state.queries} selection=${flag(state.selection)} canvas=${flag(state.canvas)} ` +
    `entry=${flag(state.activeEntry)} grants=${state.grants} undo=${state.undo} ` +
    `debounces=${state.debounces} pending=${state.pendingMutations} reset=${state.reset}`
  );
}

/**
 * Records one completed reset step and rewrites the marker element
 * synchronously — called by the provider's internal reset observer after
 * each step's action, so the DOM text always reports the real post-step
 * state (queries really removed, stores really cleared) rather than an
 * assumed destination.
 */
export function recordShellResetStepDone(step: ShellResetStep, queryClient: QueryClient): void {
  if (step === 'navigate') return;
  useResetTraceStore.getState().record(step);
  const text = formatShellState({
    queries: sessionQueryCount(queryClient),
    ...shellStoreSnapshot(),
    reset: shellResetTrace(),
  });
  const element = document.querySelector('[data-testid="shell-state"]');
  if (element !== null) element.textContent = text;
  document.documentElement.dataset.astroixResetTrace = shellResetTrace();
}

/** The marker's live component — React-rendered between resets, identical in format to the reset's direct write. */
export function ShellStateMarker(): ReactNode {
  const { queryClient } = useShell();
  const selection = useAppStore((s) => s.selection !== null);
  const canvas = useAppStore((s) => s.canvas !== null);
  const activeEntry = useAppStore((s) => s.activeEntry !== null);
  const grants = useEditSessionStore((s) => s.grants.length);
  const undo = useEditSessionStore((s) => s.undo.length);
  const debounces = useEditSessionStore((s) => s.debounces.length);
  const pendingMutations = useEditSessionStore((s) => s.pendingMutations.length);
  const trace = useResetTraceStore((s) => s.steps.join(',') || 'none');
  const [, setCacheTick] = useState(0);

  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe(() => setCacheTick((t) => t + 1));
    return unsubscribe;
  }, [queryClient]);

  const text = formatShellState({
    queries: sessionQueryCount(queryClient),
    selection,
    canvas,
    activeEntry,
    grants,
    undo,
    debounces,
    pendingMutations,
    reset: trace,
  });
  return (
    <p data-testid="shell-state" data-astroix-reset={trace}>
      {text}
    </p>
  );
}
