import type { QueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import type { AppClient, SessionClient } from '../app-client.ts';
import type { ShellRole } from '../roles/capabilities.ts';
import type { SessionGate } from '../state/session-gate.ts';

/**
 * The shell's context (#241, G2): what every shell component — and every
 * future vertical feature mounted in a slot — reaches the session
 * through. One AppClient (the one-AppClient law, #332), one SessionClient
 * bound at the document's exact pair, the role's capability row, the
 * host's QueryClient, the session gate, the session-scoped abort signal,
 * the stream state, and the one ordered reset.
 */

/** The stream's honest display state — the pages' `stream-state` vocabulary (#240's surface, retained). */
export type ShellStreamState = 'connecting' | 'open' | 'stale' | 'unavailable' | 'ended' | 'failed';

/** The shell-wide context value. */
export interface ShellContextValue {
  readonly client: AppClient;
  readonly session: SessionClient;
  readonly role: ShellRole;
  readonly queryClient: QueryClient;
  readonly gate: SessionGate;
  /** The session-scoped abort signal — every shell fetch chains it; the reset aborts it. */
  readonly sessionAbort: AbortSignal;
  readonly streamState: ShellStreamState;
  /**
   * The one ordered reset (transition-commit teardown): abort fetches,
   * close SSE, remove old-generation queries, clear the stores — then
   * navigate. `url` overrides the default launcher replacement.
   */
  reset(url?: string): void;
  /** The single command-error surface (`command-error`, #240's retained testid). */
  readonly commandError: string | null;
  reportCommandError(error: unknown): void;
  clearCommandError(): void;
}

export const ShellContext = createContext<ShellContextValue | null>(null);

/** The shell components' accessor — throws outside a provider (a shell piece without its shell is a wiring bug). */
export function useShell(): ShellContextValue {
  const value = useContext(ShellContext);
  if (value === null) throw new Error('useShell needs the ShellProvider above it');
  return value;
}
