import type { ReactNode } from 'react';
import { DeactivateControl } from './deactivate-control.tsx';
import { useShell } from './shell-context.ts';

/**
 * The shell's header (#241, G2; CONTEXT.md: the shell is "the Astroix-
 * rendered application hosting the workbench row"): the session's
 * public identity (the retained `session-generation` surface, #240),
 * the document's role badge, and the role-permitted lifecycle controls.
 * Identity is correlation data only (ADR-0006 §3) — the badge names the
 * ROLE, never any authority.
 */

/** The shell header: session identity, role, lifecycle controls. */
export function ShellHeader(): ReactNode {
  const { session, role } = useShell();
  return (
    <header data-astroix-shell-header>
      <span data-testid="session-generation">{session.ref.generation}</span>
      <span data-astroix-role-badge={role}>{role}</span>
      <DeactivateControl />
    </header>
  );
}
