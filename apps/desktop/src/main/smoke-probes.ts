import type { BrowserWindow } from 'electron';
import type { SecurityDenialRecorder } from './security-policy.ts';

/**
 * The instrumented security smoke (#243, H1 focused tests): runs against
 * the REAL Electron main wiring inside the real process — evidence for
 * the lane gate (`npm run test:desktop`), never release evidence
 * (ADR-0008: an instrumented Electron build may test wiring but is never
 * release evidence). It observes the window the product composition
 * created and attempts, from the renderer, everything the security
 * posture must deny: permissions, popups, downloads, webviews, unapproved
 * top-level navigation — and asserts the no-bridge law (no process, no
 * require, no exposed Electron surface).
 *
 * Findings print as `astroix-desktop-smoke: <json>` lines the harness
 * asserts on; the process then idles (the harness owns its lifetime).
 */

interface Finding {
  readonly probe: string;
  readonly denied: boolean;
  readonly detail: Record<string, unknown>;
}

function report(finding: Finding): void {
  console.log(`astroix-desktop-smoke: ${JSON.stringify(finding)}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs every probe against the product-created window and prints one finding line per probe. */
export async function runSecuritySmokeProbes(
  window: BrowserWindow | undefined,
  recorder: SecurityDenialRecorder,
  createdPreferences: unknown,
): Promise<void> {
  if (window === undefined) {
    console.error('astroix-desktop-smoke: no window was created');
    return;
  }
  const wc = window.webContents;
  await new Promise<void>((resolve) => {
    if (!wc.isLoading()) {
      resolve();
      return;
    }
    wc.once('did-finish-load', () => resolve());
  });

  report(preferencesProbe(createdPreferences));
  report(await popupProbe(wc));
  report(await permissionProbe(window, recorder));
  report(await downloadProbe(window, recorder));
  report(await webviewProbe(wc));
  report(await navigationProbe(window));
  report(await bridgeProbe(wc));
  console.log('astroix-desktop-smoke: done');
}

type WebContentsLike = BrowserWindow['webContents'];

/**
 * The security preferences the product wiring actually created the window
 * with, observed at the real `new BrowserWindow(...)` call inside
 * index.ts's seam. Electron 44 removed `webContents.getLastWebPreferences`
 * from the public API — the supported truth is the preferences observed at
 * creation — so this finding pins the creation input, while the
 * renderer-side probes (bridge, webview, popup) prove Electron's live
 * enforcement of the same posture.
 */
function preferencesProbe(createdPreferences: unknown): Finding {
  const created = createdPreferences as Record<string, unknown> | undefined;
  const flag = (name: string): boolean | undefined => {
    const value = created?.[name];
    return value === undefined ? undefined : value === true;
  };
  const detail = {
    contextIsolation: flag('contextIsolation') === true,
    sandbox: flag('sandbox') === true,
    webSecurity: flag('webSecurity') !== false,
    nodeIntegration: flag('nodeIntegration') === true,
    nodeIntegrationInWorker: flag('nodeIntegrationInWorker') === true,
    nodeIntegrationInSubFrames: flag('nodeIntegrationInSubFrames') === true,
    webviewTag: flag('webviewTag') === true,
    preload: created?.preload ?? null,
  };
  const secure =
    detail.contextIsolation &&
    detail.sandbox &&
    detail.webSecurity &&
    !detail.nodeIntegration &&
    !detail.nodeIntegrationInWorker &&
    !detail.nodeIntegrationInSubFrames &&
    !detail.webviewTag &&
    detail.preload === null;
  return { probe: 'preferences', denied: secure, detail };
}

/** window.open must return null — the popup path is denied wholesale. */
async function popupProbe(wc: WebContentsLike): Promise<Finding> {
  const opened = await wc.executeJavaScript(
    "(() => { const opened = window.open('about:blank'); return opened === null; })()",
  );
  const blocked = opened === true;
  return { probe: 'popup', denied: blocked, detail: { windowOpenReturnedNull: blocked } };
}

/**
 * Permission requests must be denied. The renderer-side permission APIs
 * do not reliably reflect the handler's decision on the neutral document
 * (Electron resolves `Notification.requestPermission`'s promise from its
 * own state, and geolocation rejects as insecure-origin before asking),
 * so the probe drives real permission traffic that DOES route through
 * the installed handlers — `Notification.requestPermission()` (the
 * request path) and `navigator.permissions.query` (the check path) — and
 * asserts the PRODUCT handlers' own evidence hooks recorded each denial.
 */
async function permissionProbe(
  window: BrowserWindow,
  recorder: SecurityDenialRecorder,
): Promise<Finding> {
  const before = recorder.counts();
  await window.webContents.executeJavaScript(
    `Promise.allSettled([
       Notification.requestPermission(),
       navigator.permissions.query({ name: 'notifications' }),
       navigator.permissions.query({ name: 'geolocation' }),
     ])`,
  );
  await delay(500);
  const after = recorder.counts();
  const requestsDenied = after.permissionRequests > before.permissionRequests;
  const checksDenied = after.permissionChecks > before.permissionChecks;
  return {
    probe: 'permissions',
    denied: requestsDenied && checksDenied,
    detail: { before, after },
  };
}

/** A data-URL anchor download must be prevented (the will-download denial) — the product handler's own evidence counts it. */
async function downloadProbe(
  window: BrowserWindow,
  recorder: SecurityDenialRecorder,
): Promise<Finding> {
  const before = recorder.counts().downloads;
  await window.webContents.executeJavaScript(
    `(() => {
       const anchor = document.createElement('a');
       anchor.href = 'data:text/plain,astroix-smoke';
       anchor.download = 'astroix-smoke.txt';
       document.body.append(anchor);
       anchor.click();
       anchor.remove();
     })()`,
  );
  await delay(700);
  const denied = recorder.counts().downloads > before;
  return { probe: 'download', denied, detail: { downloadsDenied: recorder.counts().downloads } };
}

/** A <webview> attach must never reach will-attach-webview (webviewTag is false). */
async function webviewProbe(wc: WebContentsLike): Promise<Finding> {
  let attaches = 0;
  wc.on('will-attach-webview', () => {
    attaches += 1;
  });
  await wc.executeJavaScript(
    `(() => {
       const view = document.createElement('webview');
       view.setAttribute('src', 'about:blank');
       document.body.append(view);
       setTimeout(() => view.remove(), 600);
     })()`,
  );
  await delay(700);
  return {
    probe: 'webview',
    denied: attaches === 0,
    detail: { willAttachWebviewFired: attaches > 0 },
  };
}

/** A top-level navigation off the neutral document must be prevented — the URL must not change. */
async function navigationProbe(window: BrowserWindow): Promise<Finding> {
  // #362: the window's document is the composition's launcher origin
  // once booted (the neutral document only before it) — the probe's law
  // is the STAY, whichever approved document the window stands on.
  const before = window.webContents.getURL();
  await window.webContents.executeJavaScript(`window.location.href = 'https://astroix.invalid/'`);
  await delay(500);
  const stayed = window.webContents.getURL() === before;
  return { probe: 'navigation', denied: stayed, detail: { url: window.webContents.getURL() } };
}

/** The no-bridge law: no process, no require, no Electron surface in the renderer. */
async function bridgeProbe(wc: WebContentsLike): Promise<Finding> {
  const surface = (await wc.executeJavaScript(
    `({
       hasProcess: typeof process !== 'undefined',
       hasRequire: typeof require !== 'undefined',
       hasGlobalElectron: typeof globalThis.electron !== 'undefined',
     })`,
  )) as Record<string, boolean>;
  const clean = !surface.hasProcess && !surface.hasRequire && !surface.hasGlobalElectron;
  return { probe: 'bridge', denied: clean, detail: surface };
}
