import type { QueryClient } from '@tanstack/react-query';
import { removeSessionQueries } from '../query/session-query-cache.ts';
import { clearRegisteredFeatureStores } from '../state/feature-store-registry.ts';
import type { SessionGate } from '../state/session-gate.ts';
import { clearShellStores } from '../state/shell-stores.ts';

/**
 * The one ordered reset operation (#241, G2; ADR-0006 §5 / ADR-0002
 * amendment 3 — the transition-commit teardown): at commit the client
 * aborts old fetches, closes old SSE, removes old-generation queries,
 * and clears the shell stores — live selection, canvas state, active
 * entry, edit grants, undo state, pending mutations — BEFORE
 * navigation. The order is the contract: navigation is the LAST step,
 * and nothing session-scoped survives it. The clearing list's
 * "scheduled debounces" die here too, but not as a store slot: the
 * navigate step's document replacement kills every pending timer, the
 * consuming hook's unmount cleanup cancels them first, and a fire that
 * raced past both meets the pair-bind anchor clear's `source-drift`
 * refusal.
 *
 * The `clear-stores` step's reach includes the FEATURE stores (#372,
 * ruled 2026-09-04): every feature-local zustand store registered with
 * the state layer's reset registry clears inside the same step, right
 * after the shell stores — the store's reset semantics stay
 * feature-owned, the timing is the sequencer's.
 *
 * `runShellReset` is the explicit sequencer: the pinned step order, an
 * action per step, and injectable observers (the unit tests pin the
 * exact order by observing every step); `composeShellReset` wires the
 * real shell surfaces — the session abort controller, the events
 * subscription, the host's QueryClient, the gate plus the shell stores,
 * and the navigation callback — into those actions.
 */

/** The pinned reset order — abort, close, remove, clear, then navigate. Never reordered. */
export const SHELL_RESET_STEPS = [
  'abort-fetches',
  'close-sse',
  'remove-queries',
  'clear-stores',
  'navigate',
] as const;

export type ShellResetStep = (typeof SHELL_RESET_STEPS)[number];

/** One action per step — keyed by step name, so a step cannot exist without its action. */
export interface ShellResetActions {
  abortFetches(): void;
  closeEvents(): void;
  removeQueries(): void;
  clearStores(): void;
  navigate(): void;
}

/** The sequencer's observers — `onStep` fires before a step's action, `onStepDone` after it. */
export interface ShellResetObserver {
  onStep?(step: ShellResetStep): void;
  onStepDone?(step: ShellResetStep): void;
}

/** The step-to-action map — a step cannot exist without its action. */
const STEP_ACTIONS: Readonly<Record<ShellResetStep, keyof ShellResetActions>> = {
  'abort-fetches': 'abortFetches',
  'close-sse': 'closeEvents',
  'remove-queries': 'removeQueries',
  'clear-stores': 'clearStores',
  navigate: 'navigate',
};

/** Runs the ordered reset — synchronous, each step observed before and after its action. */
export function runShellReset(actions: ShellResetActions, observer?: ShellResetObserver): void {
  for (const step of SHELL_RESET_STEPS) {
    observer?.onStep?.(step);
    actions[STEP_ACTIONS[step]]();
    observer?.onStepDone?.(step);
  }
}

/** The real surfaces the composition wires into the sequencer's actions. */
export interface ShellResetCompositionInputs {
  /** The session-scoped abort controller — every shell fetch's signal derives from it. */
  readonly fetchAbort: { abort(): void };
  /** The session-scoped events subscription (`SseSubscription#close` is idempotent). */
  readonly events: { close(): void };
  readonly queryClient: QueryClient;
  readonly gate: SessionGate;
  /** The top-level replacement — `location.replace` in a host, injectable in tests. */
  readonly navigate: (url: string) => void;
  /** The URL the final step replaces the top level with. */
  readonly url: string;
}

/** Wires the real shell surfaces into one runnable reset — what the shell provider's `reset()` executes. */
export function composeShellReset(inputs: ShellResetCompositionInputs): {
  run(observer?: ShellResetObserver): void;
} {
  return {
    run: (observer?: ShellResetObserver) =>
      runShellReset(
        {
          abortFetches: () => inputs.fetchAbort.abort(),
          closeEvents: () => inputs.events.close(),
          removeQueries: () => removeSessionQueries(inputs.queryClient),
          clearStores: () => {
            clearShellStores();
            clearRegisteredFeatureStores();
            inputs.gate.move(null);
          },
          navigate: () => inputs.navigate(inputs.url),
        },
        observer,
      ),
  };
}
