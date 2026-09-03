import type { ProjectKey, SessionRef } from '@wojciechpiskorz/astroix-protocol';
import type { ClientBindings } from '../../api/http/client-bindings.ts';
import type {
  ClientDocument,
  SessionClients,
} from '../../session-supervisor/clients/session-clients.ts';

/**
 * The document-bound client authority (#246, H4; ADR-0006 §3 "Electron
 * also binds a random per-document client capability to the exact
 * authoritative `webContents`, top-level navigation, and `SessionRef`"):
 * the alignment seam F2 and F4 both name — one module that mints a
 * document's authority into BOTH client-binding truths (the HTTP table
 * the dispatch validates `x-astroix-client` against, and the
 * supervisor-side registry the switch coordinator revokes) and keeps
 * them revoked in lockstep. F2's table answers "may this HEADER act";
 * F4's registry answers "may this CLIENT act"; this module owns WHEN a
 * document binding exists and WHEN it dies — the host-driven half both
 * settled surfaces deferred to this lane.
 *
 * The binding law (every AC of #246):
 * - one authoritative editor and up to three read-only diagnostics,
 *   server-enforced across BOTH tables (`bind` refuses the second
 *   editor and the fourth diagnostic, and a partial install rolls
 *   back — the two truths never disagree);
 * - an editor binding names the host-declared authoritative
 *   `webContents` at its CURRENT top-level navigation and the exact
 *   `SessionRef` — a stale navigation, a foreign `webContents`, or a
 *   dead pair never acquires or upgrades authority (the A→B→A guard:
 *   the returning A generation is a NEW pair whose editor authority is
 *   minted only for the new document, never reused by the old one);
 * - navigation, renderer loss, target destruction, session
 *   replacement, and authority revocation each invalidate BOTH tables
 *   synchronously — the invalidation returns only after the tables are
 *   updated, so no further control work can admit against a dead
 *   binding.
 *
 * Each grant therefore carries TWO separately minted capabilities —
 * `capability`, the HTTP-side value Electron injects as
 * `x-astroix-client`, and `clientCapability`, the supervisor-side value
 * — the settled two-truth shape the web host's executor and the switch
 * coordinator's receipt already compose (F6's ordered revocation unbinds
 * both; this module's invalidations do the same).
 *
 * The `webContentsId` and `navigationId` are opaque host-supplied
 * values (F4's law); the ONLY interpretation here is equality and a
 * monotonic max on the per-`webContents` navigation observation (a
 * reordered older report can never un-stale a document). Pure module:
 * no IO, no Electron import — the Electron host lane's wiring
 * (`apps/desktop/src/document-authority/`) drives it over an injected
 * port; this file is the server-side truth the desktop composition and
 * the web host's stand-in compose (the web host's `adoptSession`
 * inlines the same two-truth mint today — this module is that
 * discipline, drawn once, with the lockstep rollback the inline shape
 * lacks).
 *
 * One document holds at most ONE binding: an exact `webContents` at an
 * exact top-level navigation is one client with one role — `bind`
 * refuses a second grant at a live document (`document-already-bound`)
 * BEFORE either table mints anything (the guard reads only this
 * module's own join plus the input). Without the guard the injection
 * port would be ambiguous at a shared document; with it, the value
 * `injectableCapability` returns is total by construction.
 */

/** What `bindEditor`/`bindDiagnostic` refused — sanitized vocabulary only. */
export type DocumentAuthorityRefusal =
  /** A second authoritative editor — the one-editor cap. */
  | 'editor-already-bound'
  /** A fourth diagnostic — the three-diagnostic cap. */
  | 'diagnostics-full'
  /** The named document is not the webContents' current top-level navigation. */
  | 'stale-document'
  /** An editor bind from a webContents that is not the declared authoritative target. */
  | 'not-authoritative-target'
  /** A second grant at one exact live document — one document is one client with one role. */
  | 'document-already-bound';

/** One document-authority mint: what the composition binds and what the host injects. */
export interface DocumentAuthorityGrant {
  /** The HTTP-side capability — the `x-astroix-client` value Electron injects for this document. */
  readonly capability: string;
  /** The supervisor-side capability — the switch coordinator's client truth (F4's registry key). */
  readonly clientCapability: string;
  readonly role: 'editor' | 'diagnostic';
  readonly document: ClientDocument;
  readonly sessionRef: SessionRef;
  readonly projectKey: ProjectKey;
}

/** The host-facing port the Electron wiring consumes (a structural subset of the authority). */
export interface DocumentAuthorityPort {
  /** The live capability to inject for a webContents' current document, or null when none is bound. */
  injectableCapability(webContentsId: number): string | null;
  /** The host observed a completed top-level navigation — older bindings of that webContents die here. */
  documentNavigated(webContentsId: number, navigationId: number): void;
  /** The webContents' renderer is gone (crash or equivalent) — all its bindings die here. */
  rendererLost(webContentsId: number): void;
  /** The target (the whole webContents) is destroyed — all its bindings die here. */
  targetDestroyed(webContentsId: number): void;
}

/** The document authority surface — the composition and the host wiring drive this. */
export interface DocumentAuthority extends DocumentAuthorityPort {
  /** Declares THE authoritative webContents (ADR-0006 §3 "the exact authoritative webContents"). */
  declareAuthoritativeTarget(webContentsId: number): void;
  /**
   * Mints the authoritative editor's authority into both tables.
   * Requires the declared authoritative target at its current
   * navigation; refuses past the one-editor cap.
   */
  bindEditor(input: {
    readonly document: ClientDocument;
    readonly sessionRef: SessionRef;
    readonly projectKey: ProjectKey;
  }):
    | { readonly kind: 'bound'; readonly grant: DocumentAuthorityGrant }
    | {
        readonly kind: 'refused';
        readonly reason: DocumentAuthorityRefusal;
      };
  /**
   * Mints one read-only diagnostic's authority into both tables —
   * separately bound, separately capped (three), never an upgrade path
   * to editor authority.
   */
  bindDiagnostic(input: {
    readonly document: ClientDocument;
    readonly sessionRef: SessionRef;
    readonly projectKey: ProjectKey;
  }):
    | { readonly kind: 'bound'; readonly grant: DocumentAuthorityGrant }
    | {
        readonly kind: 'refused';
        readonly reason: DocumentAuthorityRefusal;
      };
  /** The session a commit retired — every binding at that exact pair dies here (F6's revocation order). */
  sessionReplaced(sessionRef: SessionRef): void;
  /** Revokes the one grant a capability names (debugger detach, any host-driven cause) — idempotent. */
  revoke(capability: string): void;
  /** The live document-bound grants, by capability — composition introspection and tests only. */
  grants(): readonly DocumentAuthorityGrant[];
}

/** Construction input: the two settled client-binding truths, injected and consumed, never re-implemented. */
export interface DocumentAuthorityOptions {
  /** F2's HTTP-facing table — what the dispatch validates the injected header against. */
  readonly httpBindings: ClientBindings;
  /** F4's supervisor-side registry — the switch coordinator's revocation truth. */
  readonly clients: SessionClients;
}

/** Builds one document authority over the two settled tables — the composition owns its lifetime. */
export function createDocumentAuthority(options: DocumentAuthorityOptions): DocumentAuthority {
  const { httpBindings, clients } = options;
  const live = new Map<string, DocumentAuthorityGrant>();
  const latestNavigation = new Map<number, number>();
  let authoritativeTarget: number | null = null;

  /** One mint into both tables, refused fail-closed on any cap, identity, or coherence breach. */
  function refuseOrBind(
    role: 'editor' | 'diagnostic',
    input: {
      readonly document: ClientDocument;
      readonly sessionRef: SessionRef;
      readonly projectKey: ProjectKey;
    },
  ):
    | { readonly kind: 'bound'; readonly grant: DocumentAuthorityGrant }
    | { readonly kind: 'refused'; readonly reason: DocumentAuthorityRefusal } {
    const observed = latestNavigation.get(input.document.webContentsId);
    if (observed === undefined || observed !== input.document.navigationId) {
      return { kind: 'refused', reason: 'stale-document' };
    }
    if (role === 'editor' && input.document.webContentsId !== authoritativeTarget) {
      return { kind: 'refused', reason: 'not-authoritative-target' };
    }
    // One document is one client — checked BEFORE either table mints:
    // the guard reads only this module's own join plus the input, so a
    // second grant at a live exact document refuses with nothing to
    // roll back. Without it the injection port would be ambiguous at a
    // shared document (the caps alone permit a diagnostic beside an
    // editor); with it, the value `injectableCapability` returns is
    // total by construction.
    for (const grant of live.values()) {
      if (
        grant.document.webContentsId === input.document.webContentsId &&
        grant.document.navigationId === input.document.navigationId
      ) {
        return { kind: 'refused', reason: 'document-already-bound' };
      }
    }
    const httpBound = httpBindings.bind({ role, host: 'project', sessionRef: input.sessionRef });
    if (httpBound.kind === 'refused') {
      return {
        kind: 'refused',
        reason: httpBound.reason === 'second-editor' ? 'editor-already-bound' : 'diagnostics-full',
      };
    }
    const clientBound = clients.bind({
      role,
      document: input.document,
      sessionRef: input.sessionRef,
    });
    if (clientBound.kind === 'refused') {
      // Lockstep coherence: a refusal F4's table owes but F2's did not
      // record rolls the HTTP binding back — the two truths never
      // disagree, and the caps stay server-enforced on both sides. The
      // injected table's state cannot be pre-checked here, so the
      // rollback is this branch's alone.
      httpBindings.unbind(httpBound.capability);
      return {
        kind: 'refused',
        reason:
          clientBound.reason === 'editor-already-bound'
            ? 'editor-already-bound'
            : 'diagnostics-full',
      };
    }
    const grant: DocumentAuthorityGrant = {
      capability: httpBound.capability,
      clientCapability: clientBound.capability,
      role,
      document: input.document,
      sessionRef: input.sessionRef,
      projectKey: input.projectKey,
    };
    live.set(grant.capability, grant);
    return { kind: 'bound', grant };
  }

  /** The synchronous both-tables sweep — returns only after every matching grant is dead everywhere. */
  function sweep(matches: (grant: DocumentAuthorityGrant) => boolean): void {
    for (const [capability, grant] of live) {
      if (!matches(grant)) continue;
      live.delete(capability);
      httpBindings.unbind(capability);
      clients.revoke(grant.clientCapability);
    }
  }

  return {
    declareAuthoritativeTarget: (webContentsId) => {
      authoritativeTarget = webContentsId;
    },
    bindEditor: (input) => refuseOrBind('editor', input),
    bindDiagnostic: (input) => refuseOrBind('diagnostic', input),
    documentNavigated: (webContentsId, navigationId) => {
      // Monotonic by construction (max, never the raw report): a
      // reordered older observation cannot un-stale a document.
      const observed = latestNavigation.get(webContentsId);
      const next = observed !== undefined && observed > navigationId ? observed : navigationId;
      latestNavigation.set(webContentsId, next);
      // F4's registry sweeps its own older-navigation bindings of this
      // webContents; the sweep here mirrors it for the HTTP truth — the
      // join (this module's own record) keeps the two in lockstep.
      clients.navigated({ webContentsId, navigationId: next });
      sweep(
        (grant) =>
          grant.document.webContentsId === webContentsId && grant.document.navigationId !== next,
      );
    },
    rendererLost: (webContentsId) => {
      clients.rendererLost(webContentsId);
      sweep((grant) => grant.document.webContentsId === webContentsId);
    },
    targetDestroyed: (webContentsId) => {
      clients.rendererLost(webContentsId);
      sweep((grant) => grant.document.webContentsId === webContentsId);
      latestNavigation.delete(webContentsId);
      if (authoritativeTarget === webContentsId) authoritativeTarget = null;
    },
    sessionReplaced: (sessionRef) => {
      clients.revokeSession(sessionRef);
      sweep(
        (grant) =>
          grant.sessionRef.runtimeEpoch === sessionRef.runtimeEpoch &&
          grant.sessionRef.generation === sessionRef.generation,
      );
    },
    revoke: (capability) => {
      const grant = live.get(capability);
      if (grant === undefined) {
        // Idempotent for the HTTP capability; an unknown key touched
        // neither table's state by construction.
        httpBindings.unbind(capability);
        return;
      }
      live.delete(capability);
      httpBindings.unbind(capability);
      clients.revoke(grant.clientCapability);
    },
    injectableCapability: (webContentsId) => {
      const observed = latestNavigation.get(webContentsId);
      if (observed === undefined) return null;
      for (const [capability, grant] of live) {
        if (
          grant.document.webContentsId === webContentsId &&
          grant.document.navigationId === observed
        ) {
          return capability;
        }
      }
      return null;
    },
    grants: () => [...live.values()],
  };
}
