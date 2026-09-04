import type { ProjectKey, SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { APP_PATH } from '../../../web/src/documents.ts';
import type {
  GrantedProjectSummary,
  RegisterRefusalCode,
  TransitionOutcome,
  TransitionRefusalCode,
} from './child-protocol.ts';
import {
  type ChildStopOutcome,
  type ControlPlaneClient,
  type ControlPlaneLossReason,
  connectControlPlaneChild,
  type HostObservationAsk,
  type SpawnedChildHandle,
} from './control-plane-client.ts';
import type { AuthoritativeTargetHost } from './desktop-composition-target.ts';
import {
  buildApplicationMenu,
  dispatchMenuAction,
  type NativeMenuActionId,
  type NativeMenuActions,
  type NativeMenuDeclarations,
} from './menus.ts';
import {
  createNavigationPolicy,
  type NavigationApprovals,
  NEUTRAL_DOCUMENT_URL,
} from './navigation-policy.ts';
import {
  addExistingProject,
  type DirectoryPickerSeam,
  type NativeSelectionObserver,
} from './project-picker.ts';
import {
  applySessionSecurityPolicy,
  type SessionSecurityEvidence,
  type SessionSecuritySeam,
  WINDOW_SECURITY_PREFERENCES,
} from './security-policy.ts';

/**
 * The thin native host composition (#243, H1; ADR-0004): Electron main
 * owns ONLY windows, menus, singleton behavior, native selection,
 * navigation policy, app lifecycle, and the one-use control-plane boot —
 * nothing else. ProjectRuntime never runs here (the ticket's law): the
 * control plane is the ONE child spawned through the private boot
 * contract, and every domain question crosses the private channel.
 *
 * The composition is Electron-free: every native capability is an
 * injected seam (`index.ts` adapts the real Electron APIs), which is what
 * makes the focused main-process units — singleton, native selection,
 * stale menu action, boot-channel loss, lifecycle delegation —
 * deterministic fakes-at-the-seam tests. The real Electron wiring is the
 * smoke lane's evidence (`npm run test:desktop`).
 */

/** Product identity (ADR-0008): the name and bundle identifier the packaged app carries (plist wiring is H3's, #245). */
export const PRODUCT_NAME = 'Astroix';
/** The bundle identifier, pinned here and asserted by the smoke lane. */
export const APP_BUNDLE_IDENTIFIER = 'dev.astroix.app';

/** The app seam — lifecycle, singleton, identity. */
export interface AppLifecycleSeam {
  setName(name: string): void;
  requestSingleInstanceLock(): boolean;
  onSecondInstance(handler: () => void): void;
  onAllWindowsClosed(handler: () => void): void;
  /** The handler's return decides the quit flow: `'prevent'` defers the quit until the host's transition settles. */
  onBeforeQuit(handler: () => 'prevent' | 'proceed'): void;
  quit(): void;
  userDataPath(): string;
}

/** The host window seam. */
export interface HostWindowSeam {
  loadURL(url: string): void;
  destroy(): void;
  isDestroyed(): boolean;
  focus(): void;
  onClosed(handler: () => void): void;
  /** Popups are denied wholesale — there is no allowlist to drift from. */
  denyWindowOpen(): void;
  /** Top-level navigation decisions route the navigation policy; `'deny'` prevents the navigation. */
  onWillNavigate(handler: (url: string) => 'allow' | 'deny'): void;
}

/** The window factory seam. */
export interface BrowserWindowSeam {
  create(webPreferences: typeof WINDOW_SECURITY_PREFERENCES): HostWindowSeam;
}

/** The application-menu seam: installs the declarations and reports action clicks back. */
export interface ApplicationMenuSeam {
  setApplicationMenu(
    declarations: NativeMenuDeclarations,
    onAction: (actionId: NativeMenuActionId, projectKey?: ProjectKey) => void,
  ): void;
}

/** Everything the host needs from its environment, injected. */
export interface NativeHostSeam {
  readonly app: AppLifecycleSeam;
  readonly browserWindow: BrowserWindowSeam;
  readonly menu: ApplicationMenuSeam;
  readonly session: SessionSecuritySeam;
  readonly picker: DirectoryPickerSeam;
  /**
   * Builds the main-side authoritative-target host once the control
   * plane's origin port is known (#362, H7): the H5-guarded, H4-injected
   * editing target over the launcher origin the composition published.
   * The navigation approvals and the connected control-plane client ride
   * along — the target's window hardens under the same origin-grant
   * policy as the main window's, and its authority observations forward
   * through the private channel.
   */
  createAuthoritativeTarget(
    launcherOrigin: string,
    navigation: NavigationApprovals,
    controlPlane: ControlPlaneClient,
  ): AuthoritativeTargetHost;
  /**
   * Spawns the control-plane child — the wiring's dev adapter supplies
   * the explicit executable (never PATH discovery, a shell, system Node,
   * or Electron-as-Node; the no-fallback law, replaced by H2's packaged
   * asset adapter).
   */
  spawnControlPlaneChild(): SpawnedChildHandle;
}

/** The sanitized host events the observer surfaces (product logging; no paths, PIDs, or exit codes beyond these words). */
export type NativeHostEvent =
  | { readonly kind: 'singleton-refused' }
  | { readonly kind: 'second-instance' }
  | { readonly kind: 'control-plane-booted' }
  | { readonly kind: 'control-plane-lost'; readonly reason: ControlPlaneLossReason }
  | { readonly kind: 'registered'; readonly summary: GrantedProjectSummary }
  | { readonly kind: 'registration-refused'; readonly code: RegisterRefusalCode }
  | { readonly kind: 'selection-canceled' }
  | {
      readonly kind: 'menu-action-rejected';
      readonly reason: 'no-active-session' | 'stale-session';
    }
  | { readonly kind: 'session-active'; readonly sessionRef: SessionRef }
  | { readonly kind: 'session-idle' }
  | { readonly kind: 'activation-refused'; readonly reason: TransitionRefusalCode }
  | { readonly kind: 'quit-settled'; readonly childStop: ChildStopOutcome };

export interface NativeHostOptions {
  /** The graceful stop bound for the control-plane child (ADR-0006 §8: 5 s, the default). */
  readonly gracefulStopMs?: number;
  /** The boot deadline handed to the control-plane client (default 30 s). */
  readonly bootDeadlineMs?: number;
  /** The initial approved navigation origins (empty until the composition lane grants real ones). */
  readonly approvedOrigins?: readonly string[];
  /** Evidence hooks for the session-wide denials — pure recorders, never decisions. */
  readonly securityEvidence?: SessionSecurityEvidence;
  readonly observer?: (event: NativeHostEvent) => void;
}

/** The running host surface — what menus, the picker, and the lifecycle drive. */
export interface NativeHost {
  readonly navigation: NavigationApprovals;
  /** The composition's origin port once the child reported its boot complete; false on loss or boot timeout. */
  readonly booted: Promise<number | false>;
  addExistingProject(): Promise<void>;
  activate(projectKey: string): Promise<TransitionOutcome>;
  deactivate(): Promise<TransitionOutcome>;
  /** The quit transition: close the target WITHOUT navigation, then the ordered child stop. Idempotent. */
  quitTransition(): Promise<void>;
}

/**
 * Boots the thin host. Resolves `null` when the single-instance lock is
 * refused — the junior instance quits; the FIRST instance stays
 * authoritative and receives the second's attention through the focus
 * activation.
 */
export async function startNativeHost(
  seam: NativeHostSeam,
  options: NativeHostOptions = {},
): Promise<NativeHost | null> {
  const observer = options.observer ?? (() => {});
  const gracefulStopMs = options.gracefulStopMs ?? 5000;
  const navigation = createNavigationPolicy(options.approvedOrigins ?? []);
  seam.app.setName(PRODUCT_NAME);

  if (!seam.app.requestSingleInstanceLock()) {
    observer({ kind: 'singleton-refused' });
    seam.app.quit();
    return null;
  }

  let currentSessionRef: SessionRef | null = null;
  let window: HostWindowSeam | null = null;
  let quitRun: Promise<void> | null = null;
  let quitSettled = false;
  /** The registered projects (the sanitized summaries) — the activation menu's data. */
  const registeredProjects: GrantedProjectSummary[] = [];
  /** The main-side authoritative-target host — born when the composition's port arrives. */
  let target: AuthoritativeTargetHost | null = null;
  /** The launcher origin the composition published — the main window's idle document. */
  let launcherOrigin: string | null = null;

  // — the window: hardened preferences, popup denial, navigation policy —
  window = seam.browserWindow.create(WINDOW_SECURITY_PREFERENCES);
  window.denyWindowOpen();
  window.onWillNavigate((url) => navigation.decideNavigation(url));
  window.loadURL(NEUTRAL_DOCUMENT_URL);

  // — the session-wide denial surface —
  applySessionSecurityPolicy(seam.session, options.securityEvidence);

  /** Loads the launcher document on the main window — the idle surface (ADR-0005's neutral trusted page). */
  const showLauncher = (): void => {
    if (launcherOrigin !== null && window !== null && !window.isDestroyed()) {
      window.loadURL(`${launcherOrigin}${APP_PATH}`);
    }
  };

  /** Answers one adoption-handshake ask by driving the authoritative target. */
  const answerHostObservation = (ask: HostObservationAsk): void => {
    if (ask.kind === 'current-document') {
      const identity = target?.observeCurrentDocument() ?? null;
      controlPlane.hostObservation(ask.requestId, identity !== null, identity);
      return;
    }
    // The granted origin joins the approved navigation set before the
    // top level replaces onto it (the policy's own grant, #362).
    navigation.approveOrigin(ask.origin);
    void (target?.replaceTopLevel(ask.origin) ?? Promise.resolve(null))
      .then((identity) => {
        controlPlane.hostObservation(ask.requestId, identity !== null, identity);
      })
      .catch(() => {
        // The honest unobserved reply: a rejection must never strand
        // the child's handshake waiter without an answer (the
        // activation would hang until channel loss) or surface as an
        // unhandled rejection.
        controlPlane.hostObservation(ask.requestId, false, null);
      });
  };

  // — the ONE control-plane child through the private boot —
  const controlPlane: ControlPlaneClient = connectControlPlaneChild({
    handle: seam.spawnControlPlaneChild(),
    bootDeadlineMs: options.bootDeadlineMs,
    host: {
      onBooted: (port) => {
        observer({ kind: 'control-plane-booted' });
        launcherOrigin = `http://launcher.localhost:${port}`;
        navigation.approveOrigin(launcherOrigin);
        target = seam.createAuthoritativeTarget(launcherOrigin, navigation, controlPlane);
        showLauncher();
      },
      onLost: (reason) => observer({ kind: 'control-plane-lost', reason }),
      onSessionState: (sessionRef) => {
        currentSessionRef = sessionRef;
        if (sessionRef !== null) {
          observer({ kind: 'session-active', sessionRef });
        } else {
          observer({ kind: 'session-idle' });
        }
        installMenu();
      },
      onHostObservationAsk: answerHostObservation,
      onDocumentCapability: (webContentsId, capability) => {
        target?.documentCapability(webContentsId, capability);
      },
    },
  });

  const selectionObserver: NativeSelectionObserver = {
    onRegistered: (summary) => {
      // A re-added root answers `existed: true` with the same projectKey —
      // dedupe so the Session menu grows no duplicate Activate row (#367's
      // cheap half; the boot-time listing half stays the owner's ruling).
      const existing = registeredProjects.findIndex(
        (project) => project.projectKey === summary.projectKey,
      );
      if (existing === -1) registeredProjects.push(summary);
      else registeredProjects[existing] = summary;
      observer({ kind: 'registered', summary });
      installMenu();
    },
    onRegistrationRefused: (code) => observer({ kind: 'registration-refused', code }),
    onSelectionCanceled: () => observer({ kind: 'selection-canceled' }),
  };

  /**
   * One activation through the native surface: the authoritative target
   * PREPARES first (fresh partition, bypass active — H5's ordering law
   * holds before the control plane moves), then the delegated
   * transition drives the composition. A refused outcome surfaces the
   * sanitized reason; a completed one leaves the target loaded (the
   * adoption handshake replaced its top level mid-transition).
   */
  const activateProject = async (projectKey: ProjectKey): Promise<TransitionOutcome> => {
    if (target === null || !(await target.prepare())) {
      const refused: TransitionOutcome = { kind: 'refused', reason: 'transition-failed' };
      observer({ kind: 'activation-refused', reason: refused.reason });
      return refused;
    }
    const outcome = await controlPlane.activate(projectKey);
    if (outcome.kind === 'refused') {
      observer({ kind: 'activation-refused', reason: outcome.reason });
    }
    return outcome;
  };

  /** One deactivation: the delegated transition, then the target teardown and the launcher. */
  const deactivateProject = async (sessionRef: SessionRef): Promise<TransitionOutcome> => {
    const outcome = await controlPlane.deactivate(sessionRef);
    if (outcome.kind === 'completed') {
      await target?.teardown().catch(() => {});
      showLauncher();
    }
    return outcome;
  };

  const host: NativeHost = {
    navigation,
    booted: controlPlane.booted,
    addExistingProject: () => addExistingProject(seam.picker, controlPlane, selectionObserver),
    activate: (projectKey) => activateProject(projectKey),
    deactivate: () => {
      if (currentSessionRef === null) {
        return Promise.resolve<TransitionOutcome>({ kind: 'refused', reason: 'no-active-session' });
      }
      return deactivateProject(currentSessionRef);
    },
    quitTransition: () => {
      // The body is DEFERRED one microtask so `quitRun` is assigned
      // synchronously: `window.destroy()` fires `window-all-closed`
      // re-entrantly during the transition's own synchronous prefix, and
      // a directly-invoked body would let that re-entry start a SECOND
      // transition before the `??=` lands (observed live in the Electron
      // smoke — two quit-settled events).
      quitRun ??= Promise.resolve().then(runQuitTransition);
      return quitRun;
    },
  };

  // — menus: rebuilt on every session currency change; each install's
  // dispatch binds the declarations IT was built from, so an item clicked
  // after a switch re-checks against its own frozen capture — the
  // ADR-0006 §5 currency law, not a latest-wins envelope —
  const menuActions: NativeMenuActions = {
    addExistingProject: () => {
      void host.addExistingProject();
    },
    activate: (projectKey) => {
      void activateProject(projectKey);
    },
    deactivate: (sessionRef) => {
      void deactivateProject(sessionRef);
    },
    quit: () => {
      void host.quitTransition().then(() => seam.app.quit());
    },
    menuActionRejected: (reason) => observer({ kind: 'menu-action-rejected', reason }),
  };
  const installMenu = (): void => {
    const built = buildApplicationMenu(currentSessionRef, registeredProjects);
    seam.menu.setApplicationMenu(built, (actionId, projectKey) => {
      dispatchMenuAction(built, actionId, currentSessionRef, menuActions, projectKey);
    });
  };

  // — lifecycle delegation: window-all-closed and before-quit route the ONE quit transition —
  seam.app.onSecondInstance(() => {
    observer({ kind: 'second-instance' });
    window?.focus();
  });
  seam.app.onAllWindowsClosed(() => {
    void host.quitTransition().then(() => seam.app.quit());
  });
  seam.app.onBeforeQuit(() => {
    if (quitSettled) return 'proceed';
    void host.quitTransition().then(() => seam.app.quit());
    return 'prevent';
  });

  async function runQuitTransition(): Promise<void> {
    // §4 step 6's quit law: close the target WITHOUT navigation — the
    // close observation alone, no ready seam, no renderer consent. The
    // authoritative target's close is its OWN ordered teardown (guard,
    // authority, hygiene) before the child's ordered stop reaps the
    // active run's plane.
    if (target?.exists()) {
      await target.teardown().catch(() => {});
    }
    if (window !== null && !window.isDestroyed()) {
      const closed = new Promise<void>((resolve) => {
        window?.onClosed(resolve);
      });
      window.destroy();
      await closed;
    }
    const childStop = await controlPlane.stop(gracefulStopMs);
    quitSettled = true;
    observer({ kind: 'quit-settled', childStop });
  }

  installMenu();
  return host;
}
