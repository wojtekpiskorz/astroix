import { z } from 'zod';
import { editResultSchema, writePlanSchema } from './edits';
import { inspectionRequestSchema, inspectionResultSchema } from './inspection';
import { projectKeySchema, projectSummarySchema } from './registry';
import { sessionRefSchema } from './session';
import { sessionSnapshotSchema } from './session-state';

/**
 * The closed command/result unions (ADR-0006 §5: browser-callable global
 * control operations are exactly `listProjects()`, `activate(projectKey)`,
 * `deactivate()` — launcher and authoritative project target only; project
 * inspection and editing exist only on the active project host with its
 * current `SessionRef` and capability).
 *
 * The registry seam's own command union (register, rename, remove,
 * explicit last-known-good restore — ADR-0006 §9) is a control-plane
 * interface, not browser wire traffic: registration accepts a native
 * directory grant, never a browser-supplied path, so no register command
 * exists here. It lands with `packages/runtime`.
 */

/** How a command relates to the session scope (enforced at the envelope). */
export type SessionPresence = 'required' | 'forbidden' | 'optional';

/**
 * The one check behind every session-presence rule (ADR-0006 §3: every
 * session-scoped command, response, and event carries the exact pair; §7:
 * an idle registry read does not invent one). Returns the violation
 * message, or `null` when the presence satisfies its rule.
 */
export function sessionPresenceError(rule: SessionPresence, session: unknown): string | null {
  if (rule === 'required' && session === undefined) {
    return 'session-scoped traffic must carry its SessionRef (ADR-0006 §3)';
  }
  if (rule === 'forbidden' && session !== undefined) {
    return 'traffic that is not session-scoped must not invent a SessionRef (ADR-0006 §7)';
  }
  return null;
}

export const commandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('list-projects') }),
  z.strictObject({ kind: z.literal('activate'), projectKey: projectKeySchema }),
  z.strictObject({ kind: z.literal('deactivate') }),
  z.strictObject({ kind: z.literal('inspect'), request: inspectionRequestSchema }),
  z.strictObject({ kind: z.literal('apply-edit'), plan: writePlanSchema }),
]);

export type Command = z.infer<typeof commandSchema>;
export type CommandKind = Command['kind'];

/**
 * Session-scoping of commands (ADR-0006 §3/§5/§7):
 * - `list-projects` is an idle registry read — it must not invent a
 *   `SessionRef` (§7).
 * - `activate` may be issued from the launcher (no pair yet) or from a
 *   project target whose visible `SessionRef` is staleness-checked at
 *   execution (§5) — optional.
 * - `deactivate`, `inspect`, and `apply-edit` act on the current session
 *   and carry the exact pair or fail as stale (§3).
 */
export const COMMAND_SESSION_PRESENCE: Record<CommandKind, SessionPresence> = {
  'list-projects': 'forbidden',
  activate: 'optional',
  deactivate: 'required',
  inspect: 'required',
  'apply-edit': 'required',
};

export const resultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project-list'), projects: z.array(projectSummarySchema) }),
  z.strictObject({
    kind: z.literal('activation'),
    /** Lifecycle results carry the target reference and the current snapshot (ADR-0006 §7). */
    target: z.strictObject({
      /** The new session this activation is staging, once a generation is reserved. */
      session: sessionRefSchema,
      projectKey: projectKeySchema,
    }),
    snapshot: sessionSnapshotSchema,
  }),
  z.strictObject({
    kind: z.literal('deactivation'),
    /** The session being stopped, plus the snapshot after the transition. */
    target: z.strictObject({
      session: sessionRefSchema,
      projectKey: projectKeySchema,
    }),
    snapshot: sessionSnapshotSchema,
  }),
  z.strictObject({ kind: z.literal('inspection'), result: inspectionResultSchema }),
  z.strictObject({ kind: z.literal('edit'), result: editResultSchema }),
]);

export type Result = z.infer<typeof resultSchema>;
export type ResultKind = Result['kind'];

/**
 * Session-scoping of successful results (ADR-0006 §7: every
 * session-scoped success response carries `SessionRef`; an idle registry
 * read does not invent one). `activation`/`deactivation` responses are
 * scoped to their target pair; `project-list` is the idle read.
 */
export const RESULT_SESSION_PRESENCE: Record<ResultKind, SessionPresence> = {
  'project-list': 'forbidden',
  activation: 'required',
  deactivation: 'required',
  inspection: 'required',
  edit: 'required',
};
