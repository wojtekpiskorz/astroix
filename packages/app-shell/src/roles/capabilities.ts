/**
 * The shell's client-side role capability table (#241, G2; ADR-0006 §3
 * "one editor and up to three diagnostics are server-enforced roles, not
 * UI conventions" — this table is the shell's mirror of that server
 * truth, never a second authority): which controls and data paths a
 * document's role may surface. The server's admission
 * (`packages/runtime/api/http/command-routes.ts` `COMMAND_ROUTES`) is
 * and stays the enforcement; this data only keeps the shell from
 * EXPOSING controls the document's role could never exercise.
 *
 * The vocabulary is CONTEXT.md's: the **authoritative editing client**
 * (the server's `editor` role — one per session, owns the lifecycle
 * controls and the editor lease) and the **diagnostic target** (the
 * server's `diagnostic` role — up to three, read-only inspection).
 */

/** The two session-bound document roles the shell renders for (CONTEXT.md's terms). */
export type ShellRole = 'authoritative' | 'diagnostic';

/**
 * The closed capability vocabulary. `inspect` and `subscribe-events` are
 * the read paths; `activate`/`deactivate` the lifecycle controls;
 * `schedule-edit` the future shared edit seam's admission door
 * (ADR-0002 amendment 5 — the seam itself is NOT built here, the shell
 * only gates its door); `receive-editor-grants` the editor-grant path.
 */
export const SHELL_CAPABILITIES = [
  'inspect',
  'subscribe-events',
  'activate',
  'deactivate',
  'schedule-edit',
  'receive-editor-grants',
] as const;

export type ShellCapability = (typeof SHELL_CAPABILITIES)[number];

/**
 * The per-role capability table — data, consumed by the shell's slot and
 * control renderers. The diagnostic row is inspection-only: no lifecycle
 * control, no edit scheduling, no editor grants (ADR-0006 §3).
 */
export const ROLE_CAPABILITIES: Readonly<Record<ShellRole, readonly ShellCapability[]>> = {
  authoritative: [...SHELL_CAPABILITIES],
  diagnostic: ['inspect', 'subscribe-events'],
};

/** The role's capability list — one table read, no other rule exists. */
export function capabilitiesOf(role: ShellRole): readonly ShellCapability[] {
  return ROLE_CAPABILITIES[role];
}

/** True when `role`'s row carries `capability` — the renderers' single gate. */
export function roleCan(role: ShellRole, capability: ShellCapability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

/**
 * Maps the server's `ClientRole` vocabulary (`packages/runtime/api`:
 * `'editor' | 'diagnostic'`) onto the shell's CONTEXT.md terms. The
 * launcher role has no shell — it is the launcher document's own role,
 * never a project-document shell role.
 */
export function shellRoleFromServerRole(role: 'editor' | 'diagnostic'): ShellRole {
  return role === 'editor' ? 'authoritative' : 'diagnostic';
}
