import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import {
  bootedReport,
  documentCapabilityReport,
  observeDocumentRequest,
  registerResultReport,
  replaceTopLevelRequest,
  sessionStateReport,
  transitionResultReport,
} from './child-protocol.ts';
import type { SpawnedChildHandle } from './control-plane-client.ts';
import type { AuthoritativeTargetHost } from './desktop-composition-target.ts';
import type { NativeMenuDeclarations } from './menus.ts';
import {
  APP_BUNDLE_IDENTIFIER,
  type AppLifecycleSeam,
  type ApplicationMenuSeam,
  type BrowserWindowSeam,
  type HostWindowSeam,
  type NativeHostEvent,
  type NativeHostSeam,
  PRODUCT_NAME,
  startNativeHost,
} from './native-host.ts';
import type { DirectoryPickerSeam } from './project-picker.ts';
import type { SessionSecuritySeam } from './security-policy.ts';
import { WINDOW_SECURITY_PREFERENCES } from './security-policy.ts';

/**
 * The thin host's focused units (#243): singleton behavior (the existing
 * instance stays authoritative), the hardened window, session-currency
 * menu capture, boot-channel loss (fail closed, never restarted), native
 * selection end to end over the fake channel, and lifecycle delegation
 * (the quit transition closes the target WITHOUT navigation and stops
 * the child through the ordered stop). Everything Electron is the fake
 * seam — the real wiring is the smoke lane's evidence.
 */

const SESSION_A: SessionRef = { runtimeEpoch: 'epoch-1', generation: 1 };
const SESSION_B: SessionRef = { runtimeEpoch: 'epoch-1', generation: 2 };
type MenuActionId = 'add-existing-project' | 'activate' | 'deactivate' | 'quit';
type ExitListener = (code: number | null, signal: string | null) => void;

class FakeApp implements AppLifecycleSeam {
  lockGranted = true;
  name: string | null = null;
  quits = 0;
  private readonly secondHandlers: Array<() => void> = [];
  private readonly allClosedHandlers: Array<() => void> = [];
  private readonly beforeQuitHandlers: Array<() => 'prevent' | 'proceed'> = [];
  setName(n: string): void {
    this.name = n;
  }
  requestSingleInstanceLock(): boolean {
    return this.lockGranted;
  }
  onSecondInstance(handler: () => void): void {
    this.secondHandlers.push(handler);
  }
  onAllWindowsClosed(handler: () => void): void {
    this.allClosedHandlers.push(handler);
  }
  onBeforeQuit(handler: () => 'prevent' | 'proceed'): void {
    this.beforeQuitHandlers.push(handler);
  }
  quit(): void {
    this.quits += 1;
  }
  userDataPath(): string {
    return '/fake/user-data';
  }
  fireSecondInstance(): void {
    for (const handler of [...this.secondHandlers]) handler();
  }
  fireAllWindowsClosed(): void {
    for (const handler of [...this.allClosedHandlers]) handler();
  }
  fireBeforeQuit(): 'prevent' | 'proceed' {
    let verdict: 'prevent' | 'proceed' = 'proceed';
    for (const handler of [...this.beforeQuitHandlers]) {
      if (handler() === 'prevent') verdict = 'prevent';
    }
    return verdict;
  }
}

class FakeWindow implements HostWindowSeam {
  readonly loadedURLs: string[] = [];
  destroyed = false;
  focused = 0;
  openDenied = false;
  willNavigateHandler: ((url: string) => 'allow' | 'deny') | null = null;
  private readonly closedHandlers: Array<() => void> = [];
  loadURL(url: string): void {
    if (!this.destroyed) this.loadedURLs.push(url);
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const handler of [...this.closedHandlers]) handler();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  focus(): void {
    this.focused += 1;
  }
  onClosed(handler: () => void): void {
    this.closedHandlers.push(handler);
  }
  denyWindowOpen(): void {
    this.openDenied = true;
  }
  onWillNavigate(handler: (url: string) => 'allow' | 'deny'): void {
    this.willNavigateHandler = handler;
  }
}

class FakeChildHandle implements SpawnedChildHandle {
  readonly sent: unknown[] = [];
  spawnCount = 0;
  killed = false;
  disconnected = false;
  private readonly messageListeners: Array<(message: unknown) => void> = [];
  private readonly disconnectListeners: Array<() => void> = [];
  private readonly exitListeners: ExitListener[] = [];
  send(message: unknown): boolean | null {
    if (this.disconnected) return false;
    this.sent.push(message);
    return true;
  }
  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const listener of [...this.disconnectListeners]) listener();
  }
  kill(): void {
    this.killed = true;
    this.exit(1, 'SIGKILL');
  }
  onMessage(handler: (message: unknown) => void): void {
    this.messageListeners.push(handler);
  }
  onDisconnect(handler: () => void): void {
    this.disconnectListeners.push(handler);
  }
  onExit(handler: ExitListener): void {
    this.exitListeners.push(handler);
  }
  reply(report: unknown): void {
    for (const listener of [...this.messageListeners]) listener(report);
  }
  /** Models node: `exit` fires, the channel's `disconnect` arrives around it (the client is idempotent). */
  exit(code: number | null, signal: string | null): void {
    this.disconnected = true;
    for (const listener of this.exitListeners.splice(0)) listener(code, signal);
    for (const listener of [...this.disconnectListeners]) listener();
  }
  /** The last protocol message of one kind the child received. */
  lastOf(kind: string): Record<string, unknown> | undefined {
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      const message = this.sent[index] as Record<string, unknown> | null;
      if (message !== null && typeof message === 'object' && message.kind === kind) {
        return message;
      }
    }
    return undefined;
  }
}

import type { HostDocumentIdentityReport } from './child-protocol.ts';
import type { ControlPlaneClient } from './control-plane-client.ts';
import type { NavigationApprovals } from './navigation-policy.ts';

interface InstalledMenu {
  onAction(actionId: MenuActionId, projectKey?: string): void;
  declarations: NativeMenuDeclarations;
}

/** The fake authoritative-target host — records the native host's drives, answers programmable identities. */
class FakeTargetHost implements AuthoritativeTargetHost {
  prepared = 0;
  tornDown = 0;
  replaced: string[] = [];
  capabilities: Array<{ readonly webContentsId: number; readonly capability: string | null }> = [];
  prepareResult = true;
  currentDocument: HostDocumentIdentityReport | null = null;
  replaceResult: HostDocumentIdentityReport | null = { webContentsId: 7, navigationId: 2 };
  async prepare(): Promise<boolean> {
    this.prepared += 1;
    return this.prepareResult;
  }
  observeCurrentDocument(): HostDocumentIdentityReport | null {
    return this.currentDocument;
  }
  async replaceTopLevel(origin: string): Promise<HostDocumentIdentityReport | null> {
    this.replaced.push(origin);
    return this.replaceResult;
  }
  documentCapability(webContentsId: number, capability: string | null): void {
    this.capabilities.push({ webContentsId, capability });
  }
  async teardown(): Promise<void> {
    this.tornDown += 1;
  }
  exists(): boolean {
    return this.tornDown === 0 && this.prepared > 0;
  }
}

class FakeHostSeam implements NativeHostSeam {
  readonly app = new FakeApp();
  readonly child = new FakeChildHandle();
  readonly windows: FakeWindow[] = [];
  readonly installedMenus: InstalledMenu[] = [];
  pickerChoice: { canceled: boolean; directory: string | null } = {
    canceled: true,
    directory: null,
  };
  readonly sessionInstalls = {
    permissionRequest: 0,
    permissionCheck: 0,
    devicePermission: 0,
    willDownload: 0,
  };
  readonly browserWindow: BrowserWindowSeam = {
    create: (webPreferences) => {
      expect(webPreferences).toBe(WINDOW_SECURITY_PREFERENCES);
      const win = new FakeWindow();
      this.windows.push(win);
      return win;
    },
  };
  readonly menu: ApplicationMenuSeam = {
    setApplicationMenu: (declarations, onAction) => {
      this.installedMenus.push({ onAction, declarations });
    },
  };
  readonly session: SessionSecuritySeam = {
    setPermissionRequestHandler: () => {
      this.sessionInstalls.permissionRequest += 1;
    },
    setPermissionCheckHandler: () => {
      this.sessionInstalls.permissionCheck += 1;
    },
    setDevicePermissionHandler: () => {
      this.sessionInstalls.devicePermission += 1;
    },
    onWillDownload: () => {
      this.sessionInstalls.willDownload += 1;
    },
  };
  readonly picker: DirectoryPickerSeam = {
    showOpenDirectory: async () => this.pickerChoice,
  };
  readonly target = new FakeTargetHost();
  spawnControlPlaneChild(): SpawnedChildHandle {
    this.child.spawnCount += 1;
    return this.child;
  }
  createAuthoritativeTarget(
    _launcherOrigin: string,
    _navigation: NavigationApprovals,
    _controlPlane: ControlPlaneClient,
  ): AuthoritativeTargetHost {
    return this.target;
  }
  /** The last installed menu's action dispatch. */
  menuDispatch(): InstalledMenu {
    const last = this.installedMenus.at(-1);
    if (last === undefined) throw new Error('no menu installed');
    return last;
  }
}

function eventsLog(): NativeHostEvent[] {
  return [];
}

describe('startNativeHost — singleton behavior', () => {
  it('refuses the junior instance: quits, no window, no child, the existing instance keeps authority', async () => {
    const seam = new FakeHostSeam();
    seam.app.lockGranted = false;
    const events = eventsLog();
    const host = await startNativeHost(seam, { observer: (event) => events.push(event) });
    expect(host).toBeNull();
    expect(events).toEqual([{ kind: 'singleton-refused' }]);
    expect(seam.app.quits).toBe(1);
    expect(seam.windows).toHaveLength(0);
    expect(seam.child.spawnCount).toBe(0);
  });

  it('sets the product identity and boots the ONE control-plane child on the primary instance', async () => {
    const seam = new FakeHostSeam();
    await startNativeHost(seam, { observer: () => {} });
    expect(seam.app.name).toBe(PRODUCT_NAME);
    expect(PRODUCT_NAME).toBe('Astroix');
    expect(APP_BUNDLE_IDENTIFIER).toBe('dev.astroix.app');
    expect(seam.child.spawnCount).toBe(1);
  });

  it('focuses the existing window when a second instance launches — the first stays authoritative', async () => {
    const seam = new FakeHostSeam();
    const events = eventsLog();
    await startNativeHost(seam, { observer: (event) => events.push(event) });
    seam.app.fireSecondInstance();
    expect(seam.windows[0]?.focused).toBe(1);
    expect(events).toContainEqual({ kind: 'second-instance' });
  });
});

describe('startNativeHost — the hardened window', () => {
  it('creates exactly one window with the frozen security preferences over the neutral document', async () => {
    const seam = new FakeHostSeam();
    await startNativeHost(seam, { observer: () => {} });
    expect(seam.windows).toHaveLength(1);
    expect(seam.windows[0]?.loadedURLs).toEqual(['about:blank']);
    expect(seam.windows[0]?.openDenied).toBe(true);
    expect(seam.sessionInstalls).toEqual({
      permissionRequest: 1,
      permissionCheck: 1,
      devicePermission: 1,
      willDownload: 1,
    });
  });

  it('routes top-level navigation through the policy: unapproved denied, approved allowed', async () => {
    const seam = new FakeHostSeam();
    const host = await startNativeHost(seam, { observer: () => {} });
    expect(host).not.toBeNull();
    const window = seam.windows[0];
    expect(window?.willNavigateHandler?.('https://astroix.invalid/')).toBe('deny');
    expect(window?.willNavigateHandler?.('http://127.0.0.1:9/')).toBe('deny');
    expect(window?.willNavigateHandler?.('about:blank')).toBe('allow');
    host?.navigation.approveOrigin('http://launcher.localhost:4430');
    expect(window?.willNavigateHandler?.('http://launcher.localhost:4430/app')).toBe('allow');
  });
});

describe('startNativeHost — the control-plane boot and its loss', () => {
  it('confers the one-use capability as the first channel message and surfaces the boot', async () => {
    const seam = new FakeHostSeam();
    const events = eventsLog();
    const host = await startNativeHost(seam, { observer: (event) => events.push(event) });
    if (host === null) throw new Error('the host did not start');
    const first = seam.child.sent[0] as Record<string, unknown>;
    expect(first?.astroix).toBe('astroix.private-boot-capability');
    // The booted report carries the composition's origin port (#362):
    // the boot surfaces, the launcher origin joins the approved set, and
    // the main window loads the launcher document off the neutral one.
    seam.child.reply(bootedReport(4426));
    expect(events).toContainEqual({ kind: 'control-plane-booted' });
    await Promise.resolve();
    expect(seam.windows[0]?.loadedURLs).toContain('http://launcher.localhost:4426/__astroix/app/');
    expect(host.navigation.decideNavigation('http://launcher.localhost:4426/__astroix/app/')).toBe(
      'allow',
    );
    expect(host.navigation.decideNavigation('http://launcher.localhost:9999/__astroix/app/')).toBe(
      'deny',
    );
  });

  it('fails closed and never respawns when the boot channel is lost', async () => {
    const seam = new FakeHostSeam();
    const events = eventsLog();
    const host = await startNativeHost(seam, { observer: (event) => events.push(event) });
    seam.child.exit(74, null);
    expect(events).toContainEqual({ kind: 'control-plane-lost', reason: 'child-exit' });
    seam.pickerChoice = { canceled: false, directory: '/granted/root' };
    await host?.addExistingProject();
    expect(events).toContainEqual({
      kind: 'registration-refused',
      code: 'control-plane-unavailable',
    });
    expect(seam.child.spawnCount).toBe(1);
  });
});

describe('startNativeHost — native selection end to end', () => {
  it('forwards the granted directory to the child and surfaces the sanitized summary', async () => {
    const seam = new FakeHostSeam();
    const events = eventsLog();
    const host = await startNativeHost(seam, { observer: (event) => events.push(event) });
    seam.pickerChoice = { canceled: false, directory: '/Users/dev/site' };
    const pending = host?.addExistingProject();
    await new Promise((resolve) => setTimeout(resolve, 0)); // the async picker resolves first
    const registerMessage = seam.child.lastOf('register-root');
    expect(registerMessage?.root).toBe('/Users/dev/site');
    seam.child.reply(
      registerResultReport(registerMessage?.requestId as number, {
        ok: true,
        summary: { projectKey: 'key1', displayName: 'site', availability: 'available' },
      }),
    );
    await pending;
    expect(events).toContainEqual({
      kind: 'registered',
      summary: { projectKey: 'key1', displayName: 'site', availability: 'available' },
    });
    // no filesystem root ever crossed the surfaced events
    expect(JSON.stringify(events)).not.toContain('/Users/dev');
  });

  it('surfaces a canceled picker without touching the child channel', async () => {
    const seam = new FakeHostSeam();
    const events = eventsLog();
    const host = await startNativeHost(seam, { observer: (event) => events.push(event) });
    const sentBefore = seam.child.sent.length;
    seam.pickerChoice = { canceled: true, directory: null };
    await host?.addExistingProject();
    expect(events).toContainEqual({ kind: 'selection-canceled' });
    expect(seam.child.sent.length).toBe(sentBefore);
  });
});

describe('startNativeHost — menu session currency', () => {
  it('rebuilds the menu on every session-state report', async () => {
    const seam = new FakeHostSeam();
    await startNativeHost(seam, { observer: () => {} });
    const installsBefore = seam.installedMenus.length;
    seam.child.reply({
      astroix: 'astroix.desktop-private-channel',
      kind: 'session-state',
      sessionRef: SESSION_A,
    });
    expect(seam.installedMenus.length).toBe(installsBefore + 1);
  });

  it('rejects a stale deactivate click without touching the child', async () => {
    const seam = new FakeHostSeam();
    const events = eventsLog();
    await startNativeHost(seam, { observer: (event) => events.push(event) });
    seam.child.reply({
      astroix: 'astroix.desktop-private-channel',
      kind: 'session-state',
      sessionRef: SESSION_A,
    });
    const capturedDispatch = seam.menuDispatch();
    const sentBefore = seam.child.sent.length;
    seam.child.reply({
      astroix: 'astroix.desktop-private-channel',
      kind: 'session-state',
      sessionRef: SESSION_B,
    });
    capturedDispatch.onAction('deactivate'); // the old build's item, clicked after the switch
    expect(events).toContainEqual({ kind: 'menu-action-rejected', reason: 'stale-session' });
    expect(seam.child.sent.length).toBe(sentBefore);
  });

  it('delegates an accepted deactivate to the child with the exact current reference', async () => {
    const seam = new FakeHostSeam();
    await startNativeHost(seam, { observer: () => {} });
    seam.child.reply({
      astroix: 'astroix.desktop-private-channel',
      kind: 'session-state',
      sessionRef: SESSION_A,
    });
    const sentBefore = seam.child.sent.length;
    seam.menuDispatch().onAction('deactivate');
    expect(seam.child.lastOf('deactivate')?.sessionRef).toEqual(SESSION_A);
    expect(seam.child.sent.length).toBe(sentBefore + 1);
  });
});

describe('startNativeHost — lifecycle delegation', () => {
  it('window-all-closed runs the quit transition: close WITHOUT navigation, ordered stop, then quit', async () => {
    const seam = new FakeHostSeam();
    const events = eventsLog();
    const host = await startNativeHost(seam, { observer: (event) => events.push(event) });
    const window = seam.windows[0];
    const loadedAtBoot = window?.loadedURLs.length ?? 0;
    const quitsBefore = seam.app.quits;
    seam.app.fireAllWindowsClosed();
    await new Promise((resolve) => setTimeout(resolve, 0)); // the ordered stop disconnects first
    seam.child.exit(0, null); // the child honors the disconnect with its exit
    await host?.quitTransition();
    expect(window?.destroyed).toBe(true);
    expect(window?.loadedURLs.length).toBe(loadedAtBoot); // no navigation on the quit close
    expect(seam.child.disconnected).toBe(true);
    expect(events).toContainEqual({ kind: 'quit-settled', childStop: 'graceful' });
    expect(seam.app.quits).toBeGreaterThan(quitsBefore);
  });

  it('before-quit defers once, then proceeds after the transition settles', async () => {
    const seam = new FakeHostSeam();
    const host = await startNativeHost(seam, { observer: () => {} });
    expect(seam.app.fireBeforeQuit()).toBe('prevent');
    seam.child.exit(0, null);
    await host?.quitTransition();
    expect(seam.app.fireBeforeQuit()).toBe('proceed');
  });

  it('the quit transition is idempotent — one window close, one child stop', async () => {
    const seam = new FakeHostSeam();
    const host = await startNativeHost(seam, { observer: () => {} });
    const first = host?.quitTransition();
    const second = host?.quitTransition();
    seam.child.exit(0, null);
    await Promise.all([first, second]);
    expect(seam.windows[0]?.destroyed).toBe(true);
    expect(seam.child.killed).toBe(false);
  });

  it('the quit transition is re-entrancy safe: window-all-closed fired by destroy starts no second transition', async () => {
    const seam = new FakeHostSeam();
    const events = eventsLog();
    const host = await startNativeHost(seam, {
      gracefulStopMs: 10,
      observer: (event) => events.push(event),
    });
    expect(host).not.toBeNull();
    const window = seam.windows[0];
    if (window === undefined) throw new Error('no window');
    // Real Electron re-entrancy (observed live in the smoke lane): the
    // target's destroy synchronously emits window-all-closed, whose
    // handler re-enters quitTransition during the first transition's own
    // synchronous prefix — exactly one transition may run.
    const destroy = window.destroy.bind(window);
    window.destroy = () => {
      destroy();
      seam.app.fireAllWindowsClosed();
    };
    await host?.quitTransition();
    expect(events.filter((event) => event.kind === 'quit-settled')).toHaveLength(1);
    expect(seam.child.disconnected).toBe(true);
  });

  it('force-kills the child when the graceful bound passes', async () => {
    const seam = new FakeHostSeam();
    const events = eventsLog();
    const host = await startNativeHost(seam, {
      gracefulStopMs: 10,
      observer: (event) => events.push(event),
    });
    const stopped = host?.quitTransition();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seam.child.killed).toBe(true);
    await stopped;
    expect(events).toContainEqual({ kind: 'quit-settled', childStop: 'forced' });
  });
});

describe('startNativeHost — the activation surface (#362)', () => {
  /** Boots the host, completes the child's boot, and registers one project through the REAL selection flow. */
  async function bootedWithProject() {
    const seam = new FakeHostSeam();
    const events = eventsLog();
    const host = await startNativeHost(seam, { observer: (event) => events.push(event) });
    seam.child.reply(bootedReport(4426));
    seam.pickerChoice = { canceled: false, directory: '/granted/managed-project' };
    const pending = host?.addExistingProject();
    await new Promise((resolve) => setTimeout(resolve, 0)); // the async picker resolves first
    const registerMessage = seam.child.lastOf('register-root');
    seam.child.reply(
      registerResultReport(registerMessage?.requestId as number, {
        ok: true,
        summary: {
          projectKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
          displayName: 'managed-project',
          availability: 'available',
        },
      }),
    );
    await pending;
    return { seam, events, host };
  }

  it('dedupes the Session menu when a registered root is re-added (existed answers the same projectKey)', async () => {
    const { seam } = await bootedWithProject();
    // Re-add the same granted directory: the registry answers the same
    // projectKey summary (the `existed: true` shape) — the menu must not
    // grow a duplicate Activate row (#367's cheap half).
    seam.pickerChoice = { canceled: false, directory: '/granted/managed-project' };
    seam.menuDispatch().onAction('add-existing-project', '');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const registerMessage = seam.child.lastOf('register-root');
    seam.child.reply(
      registerResultReport(registerMessage?.requestId as number, {
        ok: true,
        summary: {
          projectKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
          displayName: 'managed-project',
          availability: 'available',
        },
      }),
    );
    const sessionItems =
      seam.installedMenus
        .at(-1)
        ?.declarations.sections.find((section) => section.label === 'Session')?.items ?? [];
    const activateRows = sessionItems.filter((item) => item.actionId === 'activate');
    expect(activateRows).toHaveLength(1);
  });

  it('shows the launcher origin once booted, and the activation entry appears with the registered project', async () => {
    const { seam } = await bootedWithProject();
    expect(seam.windows[0]?.loadedURLs).toContain('http://launcher.localhost:4426/__astroix/app/');
    const sessionItems =
      seam.installedMenus
        .at(-1)
        ?.declarations.sections.find((section) => section.label === 'Session')?.items ?? [];
    const activate = sessionItems.find((item) => item.actionId === 'activate');
    expect(activate?.label).toBe('Activate managed-project');
    expect(activate?.enabled).toBe(true);
  });

  it('activates through the menu: the target prepares first, then the delegated transition', async () => {
    const { seam, events } = await bootedWithProject();
    seam.target.currentDocument = { webContentsId: 7, navigationId: 1 };
    seam.menuDispatch().onAction('activate', 'aaaaaaaaaaaaaaaaaaaaaaaaaa');
    await new Promise((resolve) => setTimeout(resolve, 0)); // the async preparation completes
    // The target prepared BEFORE the activate request left.
    expect(seam.target.prepared).toBe(1);
    expect(seam.child.lastOf('activate')?.projectKey).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaa');
    // The child answers: the transition completes and the session flows back.
    seam.child.reply(transitionResultReport(2, { kind: 'completed', sessionRef: SESSION_A }));
    seam.child.reply(sessionStateReport(SESSION_A));
    expect(events).toContainEqual({ kind: 'session-active', sessionRef: SESSION_A });
  });

  it('refuses locally when the authoritative target cannot be prepared — no activate request leaves', async () => {
    const { seam, events } = await bootedWithProject();
    seam.target.prepareResult = false;
    seam.menuDispatch().onAction('activate', 'aaaaaaaaaaaaaaaaaaaaaaaaaa');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seam.child.lastOf('activate')).toBeUndefined();
    expect(events).toContainEqual({ kind: 'activation-refused', reason: 'transition-failed' });
  });

  it('answers the adoption handshake asks through the target and the client channel', async () => {
    const { seam } = await bootedWithProject();
    seam.target.currentDocument = { webContentsId: 7, navigationId: 1 };
    seam.target.replaceResult = { webContentsId: 7, navigationId: 2 };
    // Phase 1: the current document ask.
    seam.child.reply(observeDocumentRequest(1));
    expect(
      seam.child.sent.find(
        (message) =>
          (message as Record<string, unknown>).kind === 'host-observation-result' &&
          (message as Record<string, unknown>).requestId === 1,
      ),
    ).toMatchObject({ observed: true, document: { webContentsId: 7, navigationId: 1 } });
    // Phase 2: the top-level replacement — the origin joins the approved set first.
    seam.child.reply(
      replaceTopLevelRequest({
        requestId: 2,
        sessionRef: SESSION_A,
        projectKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
        origin: 'http://aaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:4426',
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(seam.target.replaced).toEqual(['http://aaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:4426']);
    expect(
      seam.child.sent.find(
        (message) =>
          (message as Record<string, unknown>).kind === 'host-observation-result' &&
          (message as Record<string, unknown>).requestId === 2,
      ),
    ).toMatchObject({ observed: true, document: { webContentsId: 7, navigationId: 2 } });
  });

  it('feeds the reported document capability to the target host', async () => {
    const { seam } = await bootedWithProject();
    seam.child.reply(documentCapabilityReport(7, 'cap-live'));
    expect(seam.target.capabilities).toEqual([{ webContentsId: 7, capability: 'cap-live' }]);
    seam.child.reply(documentCapabilityReport(7, null));
    expect(seam.target.capabilities).toEqual([
      { webContentsId: 7, capability: 'cap-live' },
      { webContentsId: 7, capability: null },
    ]);
  });

  it('deactivates: the delegated transition, the target teardown, and the launcher returns', async () => {
    const { seam, events } = await bootedWithProject();
    seam.child.reply(sessionStateReport(SESSION_A));
    const dispatch = seam.menuDispatch();
    dispatch.onAction('deactivate');
    expect(seam.child.lastOf('deactivate')?.sessionRef).toEqual(SESSION_A);
    const deactivateId = seam.child.lastOf('deactivate')?.requestId as number;
    seam.child.reply(transitionResultReport(deactivateId, { kind: 'completed', sessionRef: null }));
    seam.child.reply(sessionStateReport(null));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(seam.target.tornDown).toBe(1);
    expect(events).toContainEqual({ kind: 'session-idle' });
    expect(seam.windows[0]?.loadedURLs.at(-1)).toBe(
      'http://launcher.localhost:4426/__astroix/app/',
    );
  });

  it('the quit transition tears the target down before the child stop', async () => {
    const { seam, host } = await bootedWithProject();
    seam.target.prepared = 1; // a live target exists
    const settled = host?.quitTransition();
    seam.child.exit(0, null); // the ordered stop's graceful exit
    await settled;
    expect(seam.target.tornDown).toBe(1);
    expect(seam.child.disconnected).toBe(true);
  });
});
