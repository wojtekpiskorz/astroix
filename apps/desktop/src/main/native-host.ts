import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import type {
  GrantedProjectSummary,
  RegisterRefusalCode,
  TransitionOutcome,
} from './child-protocol.ts';
import {
  type ChildStopOutcome,
  type ControlPlaneClient,
  type ControlPlaneLossReason,
  connectControlPlaneChild,
  type SpawnedChildHandle,
} from './control-plane-client.ts';
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
    onAction: (actionId: NativeMenuActionId) => void,
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
  readonly booted: Promise<boolean>;
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

  // — the window: hardened preferences, popup denial, navigation policy —
  window = seam.browserWindow.create(WINDOW_SECURITY_PREFERENCES);
  window.denyWindowOpen();
  window.onWillNavigate((url) => navigation.decideNavigation(url));
  window.loadURL(NEUTRAL_DOCUMENT_URL);

  // — the session-wide denial surface —
  applySessionSecurityPolicy(seam.session, options.securityEvidence);

  // — the ONE control-plane child through the private boot —
  const controlPlane: ControlPlaneClient = connectControlPlaneChild({
    handle: seam.spawnControlPlaneChild(),
    bootDeadlineMs: options.bootDeadlineMs,
    host: {
      onBooted: () => observer({ kind: 'control-plane-booted' }),
      onLost: (reason) => observer({ kind: 'control-plane-lost', reason }),
      onSessionState: (sessionRef) => {
        currentSessionRef = sessionRef;
        installMenu();
      },
    },
  });

  const selectionObserver: NativeSelectionObserver = {
    onRegistered: (summary) => observer({ kind: 'registered', summary }),
    onRegistrationRefused: (code) => observer({ kind: 'registration-refused', code }),
    onSelectionCanceled: () => observer({ kind: 'selection-canceled' }),
  };

  const host: NativeHost = {
    navigation,
    booted: controlPlane.booted,
    addExistingProject: () => addExistingProject(seam.picker, controlPlane, selectionObserver),
    activate: (projectKey) => controlPlane.activate(projectKey),
    deactivate: () => {
      if (currentSessionRef === null) {
        return Promise.resolve<TransitionOutcome>({ kind: 'refused', reason: 'no-active-session' });
      }
      return controlPlane.deactivate(currentSessionRef);
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
    deactivate: (sessionRef) => {
      void controlPlane.deactivate(sessionRef);
    },
    quit: () => {
      void host.quitTransition().then(() => seam.app.quit());
    },
    menuActionRejected: (reason) => observer({ kind: 'menu-action-rejected', reason }),
  };
  const installMenu = (): void => {
    const built = buildApplicationMenu(currentSessionRef);
    seam.menu.setApplicationMenu(built, (actionId) => {
      dispatchMenuAction(built, actionId, currentSessionRef, menuActions);
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
    // close observation alone, no ready seam, no renderer consent.
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
