import {
  API_V1_PREFIX,
  COMMAND_MUTATION,
  type CommandKind,
} from '@wojciechpiskorz/astroix-protocol';
import type { TargetRejectionReason } from '../../origin/virtual-hosts.ts';
import { claimReservedPath } from './admission-spine.ts';

/**
 * The command-endpoint route and the command permission matrix (#234,
 * F2; ADR-0006 §5 "Browser-callable global control operations …",
 * §7 "Mutations require … / Reads require …"). Pure classification
 * only: which reserved sub-path is the protocol v1 command endpoint,
 * whether a command kind is a mutation or a read, which virtual host
 * class may carry it, and which client roles are permitted there. The
 * matrix is data — the dispatch applies it, the focused lane pins every
 * cell.
 *
 * Route matching is literal on the raw path: no percent-decoding, no
 * backslash or dot normalization (the listener already refused targets
 * whose decoded view disagrees about the reserved boundary; an encoded
 * lookalike such as `/__astroix/api%2Fv1` simply is not the literal
 * route and answers as an unknown route — fail closed, never
 * interpretively matched). The literal claim head itself is the shared
 * admission spine's (`admission-spine.ts`, #321); this matrix adds the
 * command endpoint's one law on top: a query string is not part of the
 * route — the request envelope is the whole request, so a non-empty
 * query is an unknown route, not a parameter.
 */

/** The virtual host class a reserved request arrived on — re-derived at dispatch from the Host evidence. */
export type VirtualHostClass = 'launcher' | 'project';

/**
 * The document-bound client roles (ADR-0006 §3: one authoritative
 * editor plus up to three read-only diagnostics, server-enforced; the
 * neutral launcher document is the launcher's own role). Roles are
 * validated here; the webContents-level binding that MINTS them is the
 * Electron host lane's (#246).
 */
export type ClientRole = 'launcher' | 'editor' | 'diagnostic';

/** The two exact spellings of the protocol v1 command endpoint — no other route exists on this surface. */
export const COMMAND_ENDPOINT_PATHS: readonly string[] = [API_V1_PREFIX, `${API_V1_PREFIX}/`];

/** The outcome of classifying one reserved request target against this surface's routes. */
export type ApiRouteClassification =
  | { readonly kind: 'command-endpoint' }
  | { readonly kind: 'unknown-route' }
  | { readonly kind: 'rejected-target'; readonly reason: TargetRejectionReason };

/**
 * Classifies one request target (path-plus-query, as received on the
 * reserved namespace): the command endpoint, an unknown route, or a
 * target the listener's own classification would have refused —
 * re-checked through the shared spine claim so the dispatch stays
 * fail-closed even if it is ever mounted behind a different
 * composition (absolute-form and ambiguous encodings never reach the
 * route match).
 */
export function classifyApiRoute(rawTarget: string | undefined): ApiRouteClassification {
  const claim = claimReservedPath(rawTarget);
  if (claim.kind === 'rejected-target') return { kind: 'rejected-target', reason: claim.reason };
  if (claim.kind === 'not-reserved') return { kind: 'unknown-route' };
  if (!claim.hasQuery && COMMAND_ENDPOINT_PATHS.includes(claim.path)) {
    return { kind: 'command-endpoint' };
  }
  return { kind: 'unknown-route' };
}

/** How a command kind is admitted: its transport class and its per-host role matrix. */
export interface CommandRouteRule {
  /** Mutations carry `X-Astroix-Request: 1` and exact Origin; reads require same-origin Fetch Metadata (ADR-0006 §7). */
  readonly mutation: boolean;
  /** `null` = the host class never serves this command; else the roles permitted on that host. */
  readonly roles: Readonly<Partial<Record<VirtualHostClass, readonly ClientRole[]>>>;
}

/**
 * The closed command permission matrix. The mutation bit of every cell
 * is derived from the protocol's `COMMAND_MUTATION` table — the ONE
 * home of that classification (#334) — so the server's transport law
 * and the client's wire marker cannot drift apart. Lifecycle commands
 * (`list-projects`, `activate`, `deactivate`) are launcher and
 * authoritative-project-target operations (ADR-0006 §5); inspection and
 * editing exist only on the active project host — `inspect` is the
 * diagnostic role's one read, `apply-edit` the editor's alone; the
 * launcher host serves no session-scoped command of the project plane.
 */
export const COMMAND_ROUTES: Readonly<Record<CommandKind, CommandRouteRule>> = {
  'list-projects': {
    mutation: COMMAND_MUTATION['list-projects'],
    roles: { launcher: ['launcher'], project: ['editor'] },
  },
  activate: {
    mutation: COMMAND_MUTATION.activate,
    roles: { launcher: ['launcher'], project: ['editor'] },
  },
  deactivate: {
    mutation: COMMAND_MUTATION.deactivate,
    roles: { launcher: ['launcher'], project: ['editor'] },
  },
  inspect: {
    mutation: COMMAND_MUTATION.inspect,
    roles: { project: ['editor', 'diagnostic'] },
  },
  'apply-edit': {
    mutation: COMMAND_MUTATION['apply-edit'],
    roles: { project: ['editor'] },
  },
};

/** True when `role` is permitted to issue `command` on `host` — one matrix lookup, no other rule exists. */
export function rolePermitted(
  command: CommandKind,
  host: VirtualHostClass,
  role: ClientRole,
): boolean {
  return COMMAND_ROUTES[command].roles[host]?.includes(role) ?? false;
}
