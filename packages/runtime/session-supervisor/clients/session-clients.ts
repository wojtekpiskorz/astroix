import { randomBytes } from 'node:crypto';
import { LIMITS, type SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { sameSecret } from '../../api/http/secret-compare.ts';

export type {
  MenuActionEnvelope,
  MenuActionRejection,
} from './menu-actions.ts';
export {
  captureMenuAction,
  executeMenuAction,
} from './menu-actions.ts';

/**
 * The supervisor's document-bound client registry (#236, F4; ADR-0006 §3
 * "Electron also binds a random per-document client capability to the
 * exact authoritative `webContents`, top-level navigation, and
 * `SessionRef`"; CONTEXT.md "authoritative editing client" /
 * "diagnostic target"): the session-side source of truth for WHO holds
 * client authority, at which document, for which session.
 *
 * The one authoritative editor and up to three read-only diagnostics are
 * server-enforced roles, not UI conventions — `bind` refuses a second
 * editor and a fourth diagnostic outright. Every binding carries its own
 * separately minted 256-bit capability (the protocol's request-authority
 * species, timing-safe compared through the API surface's one
 * comparator); a diagnostic's capability can never upgrade: `authorize`
 * checks the presented role against the binding's role, so a re-used
 * hostname or a rotated host cookie never turns an old tab into an
 * editor.
 *
 * A binding dies on the exact events ADR-0006 §3 names: a new top-level
 * navigation of its `webContents` (`navigated`), renderer loss
 * (`rendererLost`), debugger detach or any host-driven cause (`revoke`),
 * and session replacement (`revokeSession` — the supervisor's commit
 * linearization calls it for the outgoing session). The Electron host
 * lane (#246) owns WHEN these fire; this registry owns what they mean.
 *
 * The `webContentsId` is Electron's integer identity and `navigationId`
 * the host's per-`webContents` top-level navigation counter — both
 * opaque values the host supplies and this module never interprets
 * beyond equality. The HTTP-facing capability-lookup table
 * (`api/http/client-bindings.ts`, F2) validates presented headers; this
 * registry is the supervisor-side binding truth the host and the commit
 * lane compose — #246 aligns the two surfaces.
 */

/** The exact document a binding belongs to: one `webContents` at one top-level navigation. */
export interface ClientDocument {
  /** Electron's `webContents.id` — an opaque integer the host supplies. */
  readonly webContentsId: number;
  /** The host's top-level navigation counter for that `webContents` — a new document mints a new id. */
  readonly navigationId: number;
}

/** The session-bound client roles (ADR-0006 §3: one editor, up to three diagnostics). */
export type SessionClientRole = 'editor' | 'diagnostic';

/** The server-enforced role caps a `bind` refuses at. */
export type ClientBindingRefusal = 'editor-already-bound' | 'diagnostics-full';

/** Why presented client authority was rejected — sanitized vocabulary only. */
export type ClientRejectionReason =
  /** The capability names no live binding (unknown, revoked, or never minted). */
  | 'no-binding'
  /** The binding lives at another `webContents` — a capability never crosses documents. */
  | 'wrong-document'
  /** The binding was minted at another top-level navigation of this `webContents`. */
  | 'stale-navigation'
  /** The binding was minted at another `SessionRef` — a stale pair never upgrades. */
  | 'stale-session'
  /** The binding's role is not the role this authorization requires. */
  | 'wrong-role';

/** What one live binding records — the exact triple it was minted at, plus its role. */
export interface ClientBindingRecord {
  readonly role: SessionClientRole;
  readonly document: ClientDocument;
  readonly sessionRef: SessionRef;
}

/** What `authorize` checked a presented capability against. */
export interface ClientAuthorizationRequest {
  /** The presented capability — the injected header's value, never a URL or body field. */
  readonly capability?: string;
  /** The document the presentation claims to come from. */
  readonly document: ClientDocument;
  /** The session pair the presentation carries — must be the binding's exact pair. */
  readonly sessionRef: SessionRef;
  /** The role this authorization requires; defaults to the binding's own role check being role-agnostic. */
  readonly role?: SessionClientRole;
}

/** The registry surface. */
export interface SessionClients {
  /**
   * Installs one binding with a freshly minted capability; refuses past
   * the server-enforced caps (one editor, three diagnostics).
   */
  bind(input: {
    readonly role: SessionClientRole;
    readonly document: ClientDocument;
    readonly sessionRef: SessionRef;
  }):
    | { readonly kind: 'bound'; readonly capability: string }
    | { readonly kind: 'refused'; readonly reason: ClientBindingRefusal };
  /**
   * Resolves one presented authorization against the live bindings: the
   * capability must name a live binding whose document, session pair,
   * and role all match exactly — anything else is a sanitized rejection.
   */
  authorize(
    request: ClientAuthorizationRequest,
  ):
    | { readonly kind: 'authorized'; readonly role: SessionClientRole }
    | { readonly kind: 'rejected'; readonly reason: ClientRejectionReason };
  /**
   * A `webContents` completed a new top-level navigation: every binding
   * of that `webContents` at an older navigation is revoked (a document
   * is its exact navigation, ADR-0006 §3).
   */
  navigated(document: ClientDocument): void;
  /** The `webContents` is gone (renderer loss) — all its bindings are revoked. */
  rendererLost(webContentsId: number): void;
  /** Every binding of one session is revoked — the commit linearization's outgoing call. */
  revokeSession(sessionRef: SessionRef): void;
  /** Revokes the one binding a capability names (debugger detach, any host-driven cause) — idempotent. */
  revoke(capability: string): void;
  /** Live binding count per role — composition and tests only. */
  counts(): { readonly editor: number; readonly diagnostic: number };
}

/** Builds one registry — the supervisor (or its composition) owns its lifetime. */
export function createSessionClients(): SessionClients {
  const live = new Map<string, ClientBindingRecord>();

  const findLive = (
    presented: string | undefined,
  ): { capability: string; record: ClientBindingRecord } | null => {
    if (presented === undefined || presented.length === 0) return null;
    for (const [capability, record] of live) {
      if (sameSecret(presented, capability)) return { capability, record };
    }
    return null;
  };

  return {
    bind: (input) => {
      let editors = 0;
      let diagnostics = 0;
      for (const record of live.values()) {
        if (record.role === 'editor') editors += 1;
        else diagnostics += 1;
      }
      if (input.role === 'editor' && editors >= 1) {
        return { kind: 'refused', reason: 'editor-already-bound' };
      }
      if (input.role === 'diagnostic' && diagnostics >= 3) {
        return { kind: 'refused', reason: 'diagnostics-full' };
      }
      const capability = randomBytes(LIMITS.requestCapabilityBits / 8).toString('hex');
      live.set(capability, {
        role: input.role,
        document: input.document,
        sessionRef: input.sessionRef,
      });
      return { kind: 'bound', capability };
    },
    authorize: (request) => {
      const found = findLive(request.capability);
      if (found === null) return { kind: 'rejected', reason: 'no-binding' };
      const { record } = found;
      if (record.document.webContentsId !== request.document.webContentsId) {
        return { kind: 'rejected', reason: 'wrong-document' };
      }
      if (record.document.navigationId !== request.document.navigationId) {
        return { kind: 'rejected', reason: 'stale-navigation' };
      }
      if (
        record.sessionRef.runtimeEpoch !== request.sessionRef.runtimeEpoch ||
        record.sessionRef.generation !== request.sessionRef.generation
      ) {
        return { kind: 'rejected', reason: 'stale-session' };
      }
      if (request.role === 'editor' && record.role !== 'editor') {
        // The role requirement is a minimum: an editor may read what a
        // diagnostic reads, but a diagnostic never edits.
        return { kind: 'rejected', reason: 'wrong-role' };
      }
      return { kind: 'authorized', role: record.role };
    },
    navigated: (document) => {
      for (const [capability, record] of live) {
        if (
          record.document.webContentsId === document.webContentsId &&
          record.document.navigationId !== document.navigationId
        ) {
          live.delete(capability);
        }
      }
    },
    rendererLost: (webContentsId) => {
      for (const [capability, record] of live) {
        if (record.document.webContentsId === webContentsId) live.delete(capability);
      }
    },
    revokeSession: (sessionRef) => {
      for (const [capability, record] of live) {
        if (
          record.sessionRef.runtimeEpoch === sessionRef.runtimeEpoch &&
          record.sessionRef.generation === sessionRef.generation
        ) {
          live.delete(capability);
        }
      }
    },
    revoke: (capability) => {
      live.delete(capability);
    },
    counts: () => {
      let editor = 0;
      let diagnostic = 0;
      for (const record of live.values()) {
        if (record.role === 'editor') editor += 1;
        else diagnostic += 1;
      }
      return { editor, diagnostic };
    },
  };
}
