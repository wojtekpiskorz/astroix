import type { DocumentAuthorityPort } from '@wojciechpiskorz/astroix-runtime/client-authority';
import {
  type ClientCapabilityInjection,
  installClientCapabilityInjection,
  type WebRequestListenerSeam,
} from '../document-authority/web-request-injection.ts';
import {
  createGuardedTarget,
  type GuardedTarget,
  type GuardedWindowSeam,
} from '../service-worker/bypass-guarded-target.ts';
import type { PartitionStorageSeam } from '../service-worker/partition-hygiene.ts';
import type { AuthorityObservation, HostDocumentIdentityReport } from './child-protocol.ts';
import {
  type DocumentTargetBinding,
  type DocumentTargetEventsSeam,
  observeDocumentTarget,
} from './document-bindings.ts';
import { createEditingPartitionMinter, type EditingPartitionMinter } from './editing-partition.ts';
import { NEUTRAL_DOCUMENT_URL } from './navigation-policy.ts';

/**
 * The main-side authoritative-target host (#362, H7): the composition
 * that owns the ONE authoritative editing target's lifecycle — H5's
 * fresh nonpersistent editing partition and CDP bypass guard, H4's
 * document-target observation, and H4's client-capability injection
 * over the partition session — driven by the native host through the
 * private channel's adoption handshake.
 *
 * The authority SPLIT (the product's shape, versus the harness lanes'
 * single-process composition): the document authority's tables are the
 * CONTROL PLANE's (the child's F2/F4 truths), so the live capability is
 * MINTED control-plane-side at the adoption's bind and REPORTED here
 * (`document-capability`) — this host's mirror is the injection's
 * `injectableCapability` view and the guarded target's fail-closed
 * revoke surface, its invalidations forwarded to the child over the
 * channel so both truths die in lockstep. The mirror never binds: the
 * authoritative editor binding is the adoption's, control-plane-side.
 *
 * Electron-free beyond the structural seams (`index.ts` adapts the real
 * BrowserWindow/session/debugger): the focused units fake the seams and
 * drive the same composition the product runs.
 */

/** One created authoritative window's drive surface — the Electron adapter binds the real pieces. */
export interface TargetWindowSeam {
  /** H5's window seam — the webContents identity, the CDP debugger, the loads, the close. */
  readonly window: GuardedWindowSeam;
  /** The partition session's storage (the post-unload hygiene surface). */
  readonly storage: PartitionStorageSeam;
  /** H4's injection seam — the partition session's `webRequest`. */
  readonly webRequest: WebRequestListenerSeam;
  /** H4's document-target events — did-navigate, renderer-gone, destroyed. */
  readonly events: DocumentTargetEventsSeam;
}

/** Everything the host needs from its environment, injected. */
export interface AuthoritativeTargetSeams {
  /**
   * Creates one authoritative window on the named editing partition,
   * hardened under the host's navigation policy (the same origin-grant
   * decisions as the main window's).
   */
  createWindow(input: {
    readonly partition: string;
    readonly decideNavigation: (url: string) => 'allow' | 'deny';
  }): TargetWindowSeam;
  /** The partition minter's entropy source (crypto-grade in the product). */
  randomSuffix(): string;
  /** Forwards one authority observation to the control plane over the private channel (best-effort). */
  observeAuthority(observation: AuthorityObservation): void;
}

/** The host surface the native host drives — the adoption handshake's main-side half. */
export interface AuthoritativeTargetHost {
  /**
   * Prepares the authoritative target: a fresh nonpersistent editing
   * partition, the hardened window, H4's observation wiring, and H5's
   * bypass ACTIVE before any project request (the ordering law).
   * Re-preparation re-runs the bypass on the existing target; false
   * reports a target that could not be made ready — the activation must
   * not be sent.
   */
  prepare(): Promise<boolean>;
  /** The target's CURRENT observed document identity, or null while no valid document exists. */
  observeCurrentDocument(): HostDocumentIdentityReport | null;
  /**
   * Replaces the top level with the granted origin's app document and
   * resolves the observed identity — or null when the load could not be
   * observed (the adoption fails, the composition's aftermath converges).
   */
  replaceTopLevel(origin: string): Promise<HostDocumentIdentityReport | null>;
  /** The live document capability feed (the control plane's report) — the injection's truth. */
  documentCapability(webContentsId: number, capability: string | null): void;
  /** Tears the target down: guard disposed, authority revoked and forwarded, window closed, partition hygiene. */
  teardown(): Promise<void>;
  /** True while a target window exists (the quit transition's accounting). */
  exists(): boolean;
}

/** One live target bundle — everything one authoritative window's lifetime owns. */
interface LiveTarget {
  readonly partition: string;
  readonly created: TargetWindowSeam;
  readonly guard: GuardedTarget;
  readonly binding: DocumentTargetBinding;
  injection: ClientCapabilityInjection;
  /** The exact origins whose documents may carry a client capability (the launcher plus the granted project origins). */
  readonly ownedOrigins: Set<string>;
}

/**
 * Builds the authoritative-target host. One target at a time — the
 * supervisor-global active session (ADR-0004) has exactly one
 * authoritative editor.
 */
export function createAuthoritativeTargetHost(
  seams: AuthoritativeTargetSeams,
  launcherOrigin: string,
  decideNavigation: (url: string) => 'allow' | 'deny',
): AuthoritativeTargetHost {
  const minter: EditingPartitionMinter = createEditingPartitionMinter(seams.randomSuffix);
  /** The mirror's capability view — webContents → the live control-plane-minted capability. */
  const capabilities = new Map<number, string>();
  let live: LiveTarget | null = null;

  /**
   * The mirror's authority port — H4's host-driven invalidations: local
   * truth dies immediately, the control plane's tables die through the
   * channel forward (both truths, in lockstep, eventually — a lost
   * channel kills the child and its tables with it).
   */
  const port: DocumentAuthorityPort = {
    injectableCapability: (webContentsId) => capabilities.get(webContentsId) ?? null,
    documentNavigated: (webContentsId, navigationId) => {
      seams.observeAuthority({ kind: 'document-navigated', webContentsId, navigationId });
    },
    rendererLost: (webContentsId) => {
      capabilities.delete(webContentsId);
      seams.observeAuthority({ kind: 'renderer-lost', webContentsId });
    },
    targetDestroyed: (webContentsId) => {
      capabilities.delete(webContentsId);
      seams.observeAuthority({ kind: 'target-destroyed', webContentsId });
    },
  };

  return {
    prepare: async () => {
      if (live !== null) {
        // The existing target: the bypass re-activates (the recovered
        // target's law) or the target is not ready — never a silent pass.
        return live.guard.readiness().ready || (await live.guard.activateBypass());
      }
      const partition = minter.mint().name;
      const created = seams.createWindow({
        partition,
        decideNavigation: decideNavigation,
      });
      const binding = observeDocumentTarget(port, created.events);
      const guard = createGuardedTarget({
        window: created.window,
        // The mirror authority: the guarded target's fail-closed revoke
        // and injection read the local truth; the BIND is the adoption's
        // (control-plane-side) — this side never mints.
        authority: {
          declareAuthoritativeTarget: () => {
            // The declaration lands control-plane-side at the adoption's
            // bind; the mirror holds no bindable authority of its own.
          },
          bindEditor: () => {
            throw new Error(
              'the authoritative editor binding is minted control-plane-side; the host never binds',
            );
          },
          injectableCapability: port.injectableCapability,
          revoke: (capability) => {
            for (const [webContentsId, held] of capabilities) {
              if (held === capability) capabilities.delete(webContentsId);
            }
            seams.observeAuthority({ kind: 'revoked', capability });
          },
        },
        storage: created.storage,
      });
      const ownedOrigins = new Set<string>([launcherOrigin]);
      const injection = installClientCapabilityInjection({
        webRequest: created.webRequest,
        ownedOrigins: [...ownedOrigins],
        authority: port,
      });
      live = { partition, created, guard, binding, injection, ownedOrigins };
      const activated = await guard.activateBypass();
      if (activated && binding.currentNavigationId() < 1) {
        // A host whose `did-navigate` does not count the neutral boot:
        // one explicit neutral load (no network request — the ordering
        // law is about project requests, and none exists) makes the
        // counter's first tick a REAL observed navigation — phase 1
        // never binds at zero, H4's observed-navigation law.
        await created.window.loadUrl(NEUTRAL_DOCUMENT_URL);
      }
      return activated;
    },
    observeCurrentDocument: () => {
      if (live === null) return null;
      const navigationId = live.binding.currentNavigationId();
      // H4's law: a bind names an OBSERVED navigation — the counter is
      // zero before any completed top-level navigation, and that is no
      // document to bind at.
      if (navigationId < 1) return null;
      return { webContentsId: live.created.window.webContentsId, navigationId };
    },
    replaceTopLevel: async (origin) => {
      if (live === null) return null;
      const outcome = await live.guard.loadProjectOrigin(`${origin}/__astroix/app/`);
      if (outcome.kind !== 'loaded') return null;
      const navigationId = live.binding.currentNavigationId();
      if (navigationId < 1) return null;
      if (!live.ownedOrigins.has(origin)) {
        live.ownedOrigins.add(origin);
        // The injection's owned-origin set is install-time state: the new
        // granted origin joins by reinstalling the one listener over it.
        live.injection.detach();
        live.injection = installClientCapabilityInjection({
          webRequest: live.created.webRequest,
          ownedOrigins: [...live.ownedOrigins],
          authority: port,
        });
      }
      return { webContentsId: live.created.window.webContentsId, navigationId };
    },
    documentCapability: (webContentsId, capability) => {
      if (capability === null) {
        capabilities.delete(webContentsId);
        return;
      }
      capabilities.set(webContentsId, capability);
    },
    teardown: async () => {
      const target = live;
      live = null;
      if (target === null) return;
      target.injection.detach();
      target.binding.detach();
      // The guarded target's close: guard disposed, remaining authority
      // revoked (through the mirror — the forward keeps the control
      // plane's tables honest), the window closed, the real unload
      // awaited, THEN the partition's Service Worker state cleared.
      await target.guard.closeAndClean();
      capabilities.clear();
    },
    exists: () => live !== null,
  };
}
