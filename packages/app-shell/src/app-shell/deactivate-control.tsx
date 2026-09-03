import { type ReactNode, useState } from 'react';
import { roleCan } from '../roles/capabilities.ts';
import { useShell } from './shell-context.ts';

/**
 * The deactivation control (#241, G2; ADR-0006 §4/§5): the
 * authoritative editing client's lifecycle control. The settled
 * `deactivate` transition completes first (the server-side revocations
 * are done when it settles), THEN the one ordered reset runs — abort,
 * close, remove, clear, navigate — so no session state crosses the
 * navigation. A diagnostic target gets no control at all (the role
 * capability table's row; the server's admission is the enforcement,
 * the shell merely exposes only what the role may exercise).
 */

/** The authoritative-only deactivation button. */
export function DeactivateControl(): ReactNode {
  const { client, role, reset, reportCommandError, clearCommandError } = useShell();
  const [pending, setPending] = useState(false);
  if (!roleCan(role, 'deactivate')) return null;

  const deactivate = (): void => {
    clearCommandError();
    setPending(true);
    client
      .deactivate()
      .then(() => reset())
      .catch((error: unknown) => {
        setPending(false);
        reportCommandError(error);
      });
  };

  return (
    <button type="button" data-testid="deactivate" disabled={pending} onClick={deactivate}>
      Deactivate
    </button>
  );
}
