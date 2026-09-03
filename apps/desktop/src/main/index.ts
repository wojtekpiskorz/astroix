import { fork } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow as BrowserWindowType } from 'electron';
import { app, BrowserWindow, dialog, Menu, session } from 'electron';
import {
  type RuntimeAssets,
  resolveRuntimeAssets,
  runtimeAssetsBootDiagnostic,
} from '../runtime-assets/resolve-runtime-assets.ts';
import type { SpawnedChildHandle } from './control-plane-client.ts';
import type { NativeMenuActionId, NativeMenuDeclarations } from './menus.ts';
import type { NativeHostEvent } from './native-host.ts';
import { startNativeHost } from './native-host.ts';
import {
  createSecurityDenialRecorder,
  type WINDOW_SECURITY_PREFERENCES,
} from './security-policy.ts';

/**
 * The Electron main wiring (#243, H1): the ONLY module that imports
 * Electron — it adapts the real APIs onto the native host's injected
 * seams and supplies the host facts. Everything behavioral lives behind
 * the seams (native-host.ts and siblings); the focused units fake
 * exactly these seams and the smoke lane runs this wiring for real
 * (`npm run test:desktop`).
 *
 * Runtime-asset resolution (#244, H2): a packaged boot resolves the
 * bundled stock Node and the rebased control-plane entry from
 * `process.resourcesPath` through the internal packaged-asset adapter —
 * verified (types, containment, symlink policy, executable identity,
 * hashes) before anything spawns, with NO fallback; a dev boot declares
 * the explicit `ASTROIX_DESKTOP_NODE` executable (H1's law, unchanged).
 * Either refusal is a fail-closed boot diagnostic (sanitized — never a
 * packaged path), never a search (ADR-0008's no-fallback law).
 * `ASTROIX_DESKTOP_USER_DATA` overrides the user-data root for dev/smoke
 * isolation; the product uses Electron's standard Astroix directory
 * (ADR-0008 identity).
 */

function log(event: NativeHostEvent): void {
  console.log(`astroix-desktop: ${JSON.stringify(event)}`);
}

function failClosedBoot(diagnostic: string): void {
  console.error(`astroix-desktop: ${diagnostic}`);
  app.exit(1);
}

async function main(): Promise<void> {
  // The one resolution decision of the boot (#244, H2): packaged assets
  // (verified, no fallback) or the declared dev executable — before any
  // window, directory, or child exists.
  const runtimeAssets = await resolveRuntimeAssets({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    electronVersion: process.versions.electron ?? '',
    architecture: process.arch,
    env: process.env,
  });
  if ('code' in runtimeAssets) {
    failClosedBoot(runtimeAssetsBootDiagnostic(runtimeAssets));
    return;
  }
  if (process.env.ASTROIX_DESKTOP_USER_DATA !== undefined) {
    app.setPath('userData', process.env.ASTROIX_DESKTOP_USER_DATA);
  }
  await app.whenReady();

  const userData = app.getPath('userData');
  const privateStateDirectory = join(userData, 'private-state');
  const registryDirectory = join(userData, 'registry');
  mkdirSync(privateStateDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(registryDirectory, { recursive: true, mode: 0o700 });

  /** The denial-evidence recorder (pure counting; the smoke lane's observation). */
  const denialRecorder = createSecurityDenialRecorder();
  /** The webPreferences the real `new BrowserWindow(...)` call received (the smoke's creation-observed truth). */
  let createdPreferences: typeof WINDOW_SECURITY_PREFERENCES | undefined;

  const host = await startNativeHost(
    {
      app: {
        setName: (name) => app.setName(name),
        requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
        onSecondInstance: (handler) => app.on('second-instance', () => handler()),
        onAllWindowsClosed: (handler) => app.on('window-all-closed', () => handler()),
        onBeforeQuit: (handler) =>
          app.on('before-quit', (event) => {
            if (handler() === 'prevent') event.preventDefault();
          }),
        quit: () => app.quit(),
        userDataPath: () => app.getPath('userData'),
      },
      browserWindow: {
        create: (webPreferences) => {
          createdPreferences = webPreferences;
          const win = new BrowserWindow({
            title: 'Astroix',
            width: 1440,
            height: 900,
            minWidth: 1024,
            minHeight: 700,
            show: true,
            webPreferences: { ...webPreferences },
          });
          return adaptWindow(win);
        },
      },
      menu: {
        setApplicationMenu: (declarations, onAction) => {
          Menu.setApplicationMenu(Menu.buildFromTemplate(electronTemplate(declarations, onAction)));
        },
      },
      session: {
        setPermissionRequestHandler: (handler) =>
          session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) =>
            handler(wc, permission, (grant) => callback(grant.granted), details),
          ),
        setPermissionCheckHandler: (handler) =>
          session.defaultSession.setPermissionCheckHandler((wc, permission, originatingOrigin) =>
            handler(wc, permission, originatingOrigin),
          ),
        setDevicePermissionHandler: (handler) =>
          session.defaultSession.setDevicePermissionHandler((details) => handler(details)),
        onWillDownload: (handler) =>
          session.defaultSession.on('will-download', (event, item) => handler(event, item)),
      },
      picker: {
        showOpenDirectory: async (title) => {
          const [win] = BrowserWindow.getAllWindows();
          const choice = await (win === undefined
            ? dialog.showOpenDialog({ title, properties: ['openDirectory'] })
            : dialog.showOpenDialog(win, {
                title,
                properties: ['openDirectory', 'dontAddToRecent'],
              }));
          return { canceled: choice.canceled, directory: choice.filePaths[0] ?? null };
        },
      },
      spawnControlPlaneChild: () =>
        spawnChild(runtimeAssets, {
          privateStateDirectory,
          registryDirectory,
          declareCurrentRuntimePin:
            runtimeAssets.mode === 'dev' && process.env.ASTROIX_DESKTOP_DEV_CURRENT_PIN === '1',
        }),
    },
    { observer: log, securityEvidence: denialRecorder.evidence },
  );

  if (host !== null && process.env.ASTROIX_DESKTOP_SMOKE === 'security') {
    const { runSecuritySmokeProbes } = await import('./smoke-probes.ts');
    await runSecuritySmokeProbes(
      BrowserWindow.getAllWindows()[0],
      denialRecorder,
      createdPreferences,
    );
  }
}

/**
 * One spawned control-plane child adapted to the handle seam: the
 * RESOLVED absolute executable (the bundled stock Node when packaged —
 * `fork` never spawns a shell, and the exact-child plans the plane
 * supervisor builds later carry the same executable), the resolved entry,
 * and the mode's execArgv — dev loaders in dev, none when packaged.
 */
function spawnChild(assets: RuntimeAssets, config: unknown): SpawnedChildHandle {
  const child = fork(assets.controlPlaneEntry, [JSON.stringify(config)], {
    execPath: assets.nodeExecutable,
    execArgv: [...assets.execArgv],
    cwd: assets.childCwd,
    env: { HOME: process.env.HOME ?? '' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  return {
    send: (message) => child.send(message as never) === true,
    disconnect: () => child.disconnect(),
    kill: () => child.kill(),
    onMessage: (handler) => child.on('message', (message) => handler(message)),
    onDisconnect: (handler) => child.on('disconnect', handler),
    onExit: (handler) => child.on('exit', (code, signal) => handler(code, signal)),
  };
}

/** The window adapter: the popup denial and navigation-policy decisions onto the real webContents. */
function adaptWindow(win: BrowserWindowType) {
  return {
    loadURL: (url: string) => {
      void win.loadURL(url);
    },
    destroy: () => win.destroy(),
    isDestroyed: () => win.isDestroyed(),
    focus: () => win.focus(),
    onClosed: (handler: () => void) => win.on('closed', handler),
    denyWindowOpen: () => {
      // Popups are denied wholesale — no allowlist exists to drift from.
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    },
    onWillNavigate: (handler: (url: string) => 'allow' | 'deny') => {
      win.webContents.on('will-navigate', (event, url) => {
        if (handler(url) === 'deny') event.preventDefault();
      });
    },
  };
}

/** Maps the host's declarations onto Electron's menu template (clicks report action ids back). */
function electronTemplate(
  declarations: NativeMenuDeclarations,
  onAction: (actionId: NativeMenuActionId) => void,
): Electron.MenuItemConstructorOptions[] {
  return declarations.sections.map((section) => ({
    label: section.label,
    submenu: section.items.map((item): Electron.MenuItemConstructorOptions => {
      if (item.separator === true) return { type: 'separator' };
      const actionId = item.actionId;
      return {
        label: item.label,
        accelerator: item.accelerator,
        enabled: item.enabled,
        ...(actionId === undefined ? {} : { click: () => onAction(actionId) }),
      };
    }),
  }));
}

void main().catch((error: unknown) => {
  console.error(
    `astroix-desktop: main failed (${error instanceof Error ? error.message : String(error)})`,
  );
  app.exit(1);
});
