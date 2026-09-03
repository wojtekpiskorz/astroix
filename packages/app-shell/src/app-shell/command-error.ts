import { AppClientError } from '../app-client.ts';
import { StaleSessionResultError } from '../query/gated-session-fetch.ts';

/**
 * The shell's single command-error surface (#240's `command-error`
 * testid, retained by the rebuilt shell): every shell control reports
 * its failures here with the protocol's own sanitized vocabulary — an
 * `AppClientError`'s public error code (or its kind when no envelope
 * answered), the stale-response belt's deterministic `stale-session`,
 * and the closed `unknown` catch-all. No raw error text ever renders.
 */

/** Derives the public code one control reports — sanitized by construction. */
export function commandErrorCode(error: unknown): string {
  if (error instanceof AppClientError) return error.envelope?.error.code ?? error.kind;
  if (error instanceof StaleSessionResultError) return 'stale-session';
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  return 'unknown';
}
