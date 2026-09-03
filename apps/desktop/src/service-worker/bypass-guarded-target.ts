import type { ProjectKey, SessionRef } from '@wojciechpiskorz/astroix-protocol';
import type { DocumentAuthority } from '@wojciechpiskorz/astroix-runtime/client-authority';
import {
  type BypassFailure,
  createDebuggerGuard,
  type DebuggerGuard,
  type DebuggerGuardState,
  type DebuggerGuardStep,
  type DebuggerSeam,
} from '../main/debugger-guard.ts';
import { NEUTRAL_DOCUMENT_URL } from '../main/navigation-policy.ts';
import {
  clearServiceWorkerStateAfterUnload,
  type HygieneReport,
  type PartitionStorageSeam,
} from './partition-hygiene.ts';

/**
 * The bypass-guarded authoritative editing target (#247, H5; ADR-0009):
 * the composition that owns the three fail-closed laws of the Service
 * Worker bypass over ONE editing target —
 *
 * - **The ordering law**: no project navigation and no editor authority
 *   exists before the CDP bypass is live. Activation first boots the
 *   neutral document (`about:blank` — no network request, the law is
 *   about project requests) because CDP commands stall on a
 *   never-navigated renderer target, then runs the guard sequence;
 *   `loadProjectOrigin` and `bindEditor` each refuse while the guard
 *   is not bypassed, and the target's own action log is the sequence
 *   evidence (`neutral-boot-loaded` → `attached` → `network-enabled` →
 *   `bypass-set` → `navigation-started` → …).
 * - **The fail-closed law**: every guard failure — attach, enable,
 *   bypass, or the debugger detaching (DevTools invoked) — revokes the
 *   target's document authority through H4's runtime surface
 *   (`injectableCapability` → `revoke`, the both-truths path) and
 *   fires `onUnready`: editing is disabled before another control
 *   request can leave. Recovery is a fresh or reloaded target —
 *   `activateBypass` re-runs the sequence and a subsequent
 *   `loadProjectOrigin`/`bindEditor` may succeed again.
 * - **The hygiene law**: the partition's Service Worker registrations
 *   and Cache Storage are cleared ONLY after the old target unloads
 *   (`closeAndClean` disposes the guard, closes, awaits the real
 *   unload event, then clears) — defense in depth that replaces no
 *   live invariant (ADR-0009).
 *
 * The window arrives already created on a fresh nonpersistent editing
 * partition (`../main/editing-partition.ts` mints it; the harness or
 * the desktop composition lane creates the BrowserWindow and adapts it
 * onto `GuardedWindowSeam`). Editor mode does not reproduce project
 * Service Worker or PWA behavior — the bypass is an integrity
 * invariant, not a fidelity promise (ADR-0009).
 *
 * Electron-free beyond the structural seams: the focused units drive
 * this composition over a fake window/debugger and the REAL runtime
 * document authority; the real-Electron truth is the `e2e/desktop`
 * lane.
 */

/** The window slice the guarded target drives — the harness/composition adapter binds the real BrowserWindow. */
export interface GuardedWindowSeam {
  /** The webContents identity the document authority binds (`webContents.id`). */
  readonly webContentsId: number;
  /** The webContents' CDP debugger — the guard's seam. */
  readonly debugger: DebuggerSeam;
  /** Loads a URL into the main frame (the project origin). */
  loadUrl(url: string): Promise<void>;
  /** Destroys the window (the unload path). */
  close(): void;
  /** The window has unloaded (Electron's `closed`); returns the unbind. */
  onClosed(handler: () => void): () => void;
}

/** The authority slice the composition consumes — H4's runtime surface, read-only. */
export type GuardedTargetAuthority = Pick<
  DocumentAuthority,
  'declareAuthoritativeTarget' | 'bindEditor' | 'injectableCapability' | 'revoke'
>;

/**
 * The target's own action sequence, in order — the ordering evidence:
 * every guard step precedes the first navigation; every refusal and
 * compromise is recorded where it happened.
 */
export type GuardedTargetAction =
  | DebuggerGuardStep
  | 'neutral-boot-loaded'
  | 'neutral-boot-failed'
  | 'bypass-active'
  | 'compromised'
  | 'authority-revoked'
  | 'navigation-refused'
  | 'navigation-started'
  | 'navigation-settled'
  | 'navigation-failed'
  | 'editor-bound'
  | 'editor-bind-refused'
  | 'partition-hygiene-cleared'
  | 'partition-hygiene-failed'
  | 'target-closed';

/** What `loadProjectOrigin` did. */
export type NavigationOutcome =
  | { readonly kind: 'loaded' }
  | { readonly kind: 'refused'; readonly reason: 'bypass-not-active' }
  | { readonly kind: 'failed'; readonly detail: string };

/** What `bindEditor` did — the authority's own refusals pass through beside the bypass gate. */
export type EditorBindOutcome =
  | { readonly kind: 'bound'; readonly capability: string }
  | { readonly kind: 'refused'; readonly reason: 'bypass-not-active' | string };

/** The readiness snapshot the host reports (the focused lanes' evidence). */
export interface TargetReadiness {
  /** True only while the bypass is live and uncompromised. */
  readonly ready: boolean;
  readonly guardState: DebuggerGuardState;
  readonly failure: BypassFailure | null;
}

export interface GuardedTarget {
  /** Runs (or re-runs) the CDP bypass sequence; false reports a failure that already fired `onUnready`. */
  activateBypass(): Promise<boolean>;
  /** Loads the project origin — refused while the bypass is not live (the ordering gate). */
  loadProjectOrigin(url: string): Promise<NavigationOutcome>;
  /**
   * Binds the authoritative editor at the host-observed current
   * navigation (H4's `observeDocumentTarget` mints `navigationId`) —
   * refused while the bypass is not live.
   */
  bindEditor(input: {
    readonly sessionRef: SessionRef;
    readonly projectKey: ProjectKey;
    readonly navigationId: number;
  }): EditorBindOutcome;
  readiness(): TargetReadiness;
  /** The action sequence, in order — ordering evidence for the focused lanes. */
  actions(): readonly GuardedTargetAction[];
  /**
   * Closes the target: guard disposed, remaining authority revoked,
   * the real unload awaited, THEN the partition's Service Worker and
   * cache state cleared. Idempotent — the first report stands.
   */
  closeAndClean(): Promise<HygieneReport>;
}

export interface GuardedTargetOptions {
  readonly window: GuardedWindowSeam;
  readonly authority: GuardedTargetAuthority;
  /** The editing partition's session — the post-unload hygiene surface. */
  readonly storage: PartitionStorageSeam;
  /** The target went unready: editing is disabled before another control request (the fail-closed hook). */
  readonly onUnready?: (failure: BypassFailure) => void;
}

export function createGuardedTarget(options: GuardedTargetOptions): GuardedTarget {
  const { window, authority } = options;
  const actions: GuardedTargetAction[] = [];
  const log = (action: GuardedTargetAction): void => {
    actions.push(action);
  };

  // The unload observation: registered at construction so a target the
  // host closed on its own still settles the hygiene pass.
  let unloadSettled: (() => void) | null = null;
  const unloaded = new Promise<void>((resolve) => {
    unloadSettled = resolve;
  });
  let closed = false;
  const unbindClosed = window.onClosed(() => {
    closed = true;
    unloadSettled?.();
  });

  /**
   * The fail-closed sink: every guard failure revokes the target's
   * document authority (both truths, through H4's runtime revoke)
   * before reporting — no further control request carries authority.
   */
  function failClosed(failure: BypassFailure): void {
    const capability = authority.injectableCapability(window.webContentsId);
    if (capability !== null) {
      authority.revoke(capability);
      log('authority-revoked');
    }
    log('compromised');
    options.onUnready?.(failure);
  }

  const guard: DebuggerGuard = createDebuggerGuard({
    debugger: window.debugger,
    onStep: (step: DebuggerGuardStep) => {
      log(step);
    },
    onCompromised: (failure) => {
      // Both activation failures and mid-session detaches land here —
      // `failure.kind` distinguishes them; the log records the compromise.
      failClosed(failure);
    },
  });
  // The one declaration: this webContents is THE authoritative editing
  // target — every bind still passes the bypass gate first.
  authority.declareAuthoritativeTarget(window.webContentsId);

  let hygiene: Promise<HygieneReport> | null = null;
  let booted = false;

  /**
   * The boot document (H1's neutral placeholder): a fresh window's
   * renderer target is not live until its first navigation — CDP
   * commands on a never-navigated webContents stall forever — so
   * activation first loads `about:blank`, which issues NO network
   * request (the ordering law is about project requests, and none
   * exists yet). Once, ever; re-activations (the recovered target)
   * boot on the live document they already have.
   */
  async function bootNeutralDocument(): Promise<boolean> {
    if (booted) return true;
    try {
      await window.loadUrl(NEUTRAL_DOCUMENT_URL);
    } catch (error) {
      log('neutral-boot-failed');
      void error;
      return false;
    }
    booted = true;
    log('neutral-boot-loaded');
    return true;
  }

  return {
    activateBypass: async () => {
      if (!(await bootNeutralDocument())) return false;
      const result = await guard.activate();
      if (!result.ok) return false;
      log('bypass-active');
      return true;
    },
    loadProjectOrigin: async (url) => {
      if (!guard.isBypassActive()) {
        log('navigation-refused');
        return { kind: 'refused', reason: 'bypass-not-active' };
      }
      log('navigation-started');
      try {
        await window.loadUrl(url);
      } catch (error) {
        log('navigation-failed');
        return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) };
      }
      log('navigation-settled');
      return { kind: 'loaded' };
    },
    bindEditor: (input) => {
      if (!guard.isBypassActive()) {
        log('editor-bind-refused');
        return { kind: 'refused', reason: 'bypass-not-active' };
      }
      const bound = authority.bindEditor({
        document: { webContentsId: window.webContentsId, navigationId: input.navigationId },
        sessionRef: input.sessionRef,
        projectKey: input.projectKey,
      });
      if (bound.kind === 'refused') {
        log('editor-bind-refused');
        return { kind: 'refused', reason: bound.reason };
      }
      log('editor-bound');
      return { kind: 'bound', capability: bound.grant.capability };
    },
    readiness: () => ({
      ready: guard.isBypassActive(),
      guardState: guard.state(),
      failure: guard.failure(),
    }),
    actions: () => [...actions],
    closeAndClean: () => {
      // Idempotent: the first close-and-clean owns the report.
      if (hygiene !== null) return hygiene;
      hygiene = (async () => {
        guard.dispose();
        // Belt and braces beside H4's own targetDestroyed observation:
        // whatever authority remains dies with the target.
        const capability = authority.injectableCapability(window.webContentsId);
        if (capability !== null) {
          authority.revoke(capability);
          log('authority-revoked');
        }
        if (!closed) window.close();
        const report = await clearServiceWorkerStateAfterUnload({
          storage: options.storage,
          awaitUnload: unloaded,
        });
        log(report.ok ? 'partition-hygiene-cleared' : 'partition-hygiene-failed');
        unbindClosed();
        log('target-closed');
        return report;
      })();
      return hygiene;
    },
  };
}
