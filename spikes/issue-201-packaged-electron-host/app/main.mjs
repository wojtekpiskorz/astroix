import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { release as osRelease } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, session } from 'electron';

import {
  createHardenedWindowOptions,
  createMainFrameNavigationPolicy,
} from './src/security-policy.mjs';
import { trace } from './src/trace.mjs';

const appRoot = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.ASTROIX_PROOF_CONFIG;
if (configPath === undefined) throw new Error('ASTROIX_PROOF_CONFIG is required');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
app.setPath('userData', config.userDataDir);

const record = (event, detail = {}) => trace(config.tracePath, 'electron-main', event, detail);
const hasLock = app.requestSingleInstanceLock({ proof: 'issue-201' });
if (!hasLock) {
  record('second-instance-contender-exited');
  app.quit();
} else {
  let controlGeneration = 0;
  let controlHandle;
  let window;
  let navigationPolicy;
  let rendererRevoked = false;
  let editingEnabled = true;
  let quitting = false;
  let quitReady = false;
  const denied = {
    checks: [],
    requests: [],
    navigations: [],
    frames: [],
    popups: [],
    downloads: [],
    webviews: 0,
  };

  function killControlGroup(pid, signal) {
    if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 1) return false;
    try {
      process.kill(-pid, signal);
      record('control-process-group-signalled', { pid, signal });
      return true;
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        record('control-process-group-signal-failed', {
          pid,
          signal,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return false;
    }
  }

  function spawnControl() {
    const generation = ++controlGeneration;
    const child = fork(join(appRoot, 'src', 'control-plane.mjs'), [configPath], {
      cwd: appRoot,
      env: {
        ASTRO_DISABLE_UPDATE_CHECK: 'true',
        ASTROIX_CONTROL_ELECTRON_VERSION: process.versions.electron,
        ASTROIX_CONTROL_PARENT_PID: String(process.pid),
        ELECTRON_RUN_AS_NODE: '1',
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
      },
      detached: process.platform !== 'win32',
      execPath: process.execPath,
      serialization: 'advanced',
      shell: false,
      silent: true,
    });
    const pending = new Map();
    let nextMessageId = 1;
    let status;
    let exited = false;
    let expectedExit = false;
    let resolveReady;
    let rejectReady;
    let resolveExited;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const closed = new Promise((resolve) => (resolveExited = resolve));
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('message', (message) => {
      if (message?.type === 'ready') {
        status = message.status;
        resolveReady(message.status);
      }
      if (message?.type === 'permit-navigation') {
        navigationPolicy?.permitTransition(message.origin);
        record('project-navigation-permitted', { origin: message.origin });
        child.send({ type: 'permit-navigation-ack', replyTo: message.id });
      }
      const pendingRequest = pending.get(message?.replyTo);
      if (pendingRequest !== undefined) {
        pending.delete(message.replyTo);
        message.ok
          ? pendingRequest.resolve(message.value)
          : pendingRequest.reject(new Error(message.error));
      }
    });
    child.once('error', (error) => {
      rejectReady(error);
      for (const pendingRequest of pending.values()) pendingRequest.reject(error);
      pending.clear();
    });
    child.once('exit', (code, signal) => {
      exited = true;
      const error = new Error(
        `control plane exited: ${code}/${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
      if (status === undefined) rejectReady(error);
      for (const pendingRequest of pending.values()) pendingRequest.reject(error);
      pending.clear();
      record('control-exited', { code, signal, expected: expectedExit, generation });
      if (!expectedExit) {
        killControlGroup(child.pid, 'SIGTERM');
        setTimeout(() => killControlGroup(child.pid, 'SIGKILL'), 800).unref();
      }
      resolveExited({ code, signal, expected: expectedExit, pid: child.pid });
    });
    record('control-spawned', {
      generation,
      controlPid: child.pid,
      shell: false,
      detached: process.platform !== 'win32',
    });

    function request(type, payload = {}) {
      if (exited) return Promise.reject(new Error('control plane is not running'));
      const id = nextMessageId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.send({ id, type, ...payload }, (error) => {
          if (error) {
            pending.delete(id);
            reject(error);
          }
        });
      });
    }

    const handle = {
      child,
      closed,
      generation,
      get exited() {
        return exited;
      },
      markExpectedExit() {
        expectedExit = true;
      },
      ready,
      request,
      status: () => status,
    };
    controlHandle = handle;
    return handle;
  }

  async function bounded(operation, milliseconds, label) {
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
            milliseconds,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function shutdownControl(reason) {
    const handle = controlHandle;
    if (handle === undefined || handle.exited) return { reason, alreadyClosed: true };
    handle.markExpectedExit();
    try {
      const report = await bounded(
        handle.request('shutdown', { reason }),
        5_000,
        'control shutdown',
      );
      await bounded(handle.closed, 2_000, 'control exit');
      return report;
    } catch (error) {
      killControlGroup(handle.child.pid, 'SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 400));
      killControlGroup(handle.child.pid, 'SIGKILL');
      return {
        reason,
        forced: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function allowedCanvasNavigation(targetUrl) {
    try {
      const target = new URL(targetUrl);
      return (
        navigationPolicy !== undefined &&
        target.protocol === 'http:' &&
        target.username === '' &&
        target.password === '' &&
        target.origin === navigationPolicy.activeOrigin() &&
        !target.pathname.startsWith('/__astroix/app/')
      );
    } catch {
      return false;
    }
  }

  function installWindowSecurity(targetWindow, initialOrigin) {
    navigationPolicy = createMainFrameNavigationPolicy(initialOrigin);
    const contents = targetWindow.webContents;
    session.defaultSession.setPermissionCheckHandler((_contents, permission, origin, details) => {
      denied.checks.push({ permission, origin, requestingOrigin: details?.requestingOrigin });
      record('permission-check-denied', { permission, origin });
      return false;
    });
    session.defaultSession.setPermissionRequestHandler(
      (_contents, permission, callback, details) => {
        denied.requests.push({ permission, requestingOrigin: details?.requestingOrigin });
        record('permission-request-denied', {
          permission,
          requestingOrigin: details?.requestingOrigin,
        });
        callback(false);
      },
    );
    session.defaultSession.on('will-download', (event, item) => {
      event.preventDefault();
      denied.downloads.push(item.getURL());
      record('download-denied', { url: item.getURL() });
    });
    contents.setWindowOpenHandler((details) => {
      denied.popups.push(details.url);
      record('popup-denied', { url: details.url });
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
      denied.webviews += 1;
      record('webview-denied');
    });
    contents.on('will-navigate', (event, targetUrl) => {
      if (!navigationPolicy.allow(targetUrl)) {
        event.preventDefault();
        denied.navigations.push(targetUrl);
        record('main-navigation-denied', { url: targetUrl });
      }
    });
    contents.on('will-frame-navigate', (event, detailsOrUrl, _isInPlace, positionalIsMainFrame) => {
      const details =
        typeof detailsOrUrl === 'string'
          ? { url: detailsOrUrl, isMainFrame: positionalIsMainFrame }
          : detailsOrUrl;
      if (details?.isMainFrame || allowedCanvasNavigation(details?.url)) return;
      event.preventDefault();
      editingEnabled = false;
      denied.frames.push(details?.url);
      record('canvas-navigation-denied-editing-disabled', { url: details?.url });
      void controlHandle
        ?.request('revoke-editing', {
          reason: 'canvas-left-project-origin',
          url: details?.url,
        })
        .catch(() => {});
    });
    contents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || !navigationPolicy.cancelTransition()) return;
        record('main-navigation-failed', {
          errorCode,
          errorDescription,
          url: validatedURL,
        });
        void controlHandle?.request('navigation-failed', { url: validatedURL }).catch(() => {});
      },
    );
    contents.on('did-navigate', (_event, url) => {
      navigationPolicy.commitTransition(url);
      record('main-navigation-committed', { url });
      if (new URL(url).pathname === '/__astroix/app/') {
        void controlHandle?.request('navigation-committed', { url }).catch(() => {});
      }
    });
    contents.on('render-process-gone', (_event, details) => {
      rendererRevoked = true;
      editingEnabled = false;
      record('renderer-process-gone', details);
      void controlHandle?.request('stop-active', { reason: 'renderer-crash' }).catch(() => {});
    });
  }

  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    record('second-instance-observed', {
      additionalData,
      argvCount: argv.length,
    });
    if (window !== undefined && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.on('window-all-closed', () => record('window-all-closed-macos-retained'));
  app.on('activate', () => {
    if (rendererRevoked || window?.isDestroyed()) {
      record('dock-activate-did-not-recreate-revoked-session');
    }
  });
  app.on('before-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    record('before-quit-cleanup-started');
    void shutdownControl('app-quit').then((report) => {
      record('before-quit-cleanup-finished', { report });
      quitReady = true;
      app.quit();
    });
  });

  const ready = (async () => {
    await app.whenReady();
    const handle = spawnControl();
    const status = await handle.ready;
    window = new BrowserWindow(createHardenedWindowOptions());
    installWindowSecurity(window, status.origin);
    await window.loadURL(status.appUrl);
    window.show();
    record('browser-window-ready', { url: status.appUrl });
    return status;
  })();

  globalThis.__astroixProof = {
    async crashRenderer() {
      window.webContents.forcefullyCrashRenderer();
    },
    quit() {
      app.quit();
    },
    ready,
    async restartControl() {
      if (controlHandle !== undefined && !controlHandle.exited) {
        throw new Error('cannot restart a live control plane');
      }
      const handle = spawnControl();
      const status = await handle.ready;
      navigationPolicy = createMainFrameNavigationPolicy(status.origin);
      editingEnabled = true;
      rendererRevoked = false;
      if (window !== undefined && !window.isDestroyed()) await window.loadURL(status.appUrl);
      return status;
    },
    request(type, payload) {
      return controlHandle.request(type, payload);
    },
    status: () => ({
      arch: process.arch,
      control: controlHandle?.status(),
      controlExited: controlHandle?.exited,
      controlGeneration,
      controlPid: controlHandle?.child.pid,
      denied,
      editingEnabled,
      electronVersion: process.versions.electron,
      isPackaged: app.isPackaged,
      osRelease: osRelease(),
      platform: process.platform,
      rendererRevoked,
      resourcesPath: process.resourcesPath,
      windowCount: BrowserWindow.getAllWindows().length,
      windowPreferences:
        window === undefined || window.isDestroyed()
          ? undefined
          : window.webContents.getLastWebPreferences(),
    }),
  };
}
