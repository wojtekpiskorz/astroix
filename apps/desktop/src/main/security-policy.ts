/**
 * The BrowserWindow security posture (#243, H1; the AC's law, ADR-0004
 * "no privileged renderer bridge"): the fixed web-preference block every
 * Astroix window is created with, and the session-wide denial surface —
 * permissions, downloads, and webviews are denied wholesale; popups and
 * unapproved top-level navigation are denied by the window policy
 * (navigation-policy.ts owns that decision; this module owns the
 * permission/check/device/download denials).
 *
 * Every value here is pinned by the Electron smoke lane
 * (`npm run test:desktop`): contextIsolation ON, sandbox ON, webSecurity
 * ON, nodeIntegration OFF (worker and subframes too), webviewTag OFF,
 * no preload. The renderer receives no generic filesystem, process,
 * shell, registry, or raw-IPC bridge: with no preload and a sandboxed,
 * context-isolated renderer there is nothing to receive, and main
 * registers no ipcMain surface.
 */

/** The webPreferences block every Astroix BrowserWindow is created with — frozen, shared, never spread-and-mutated. */
export const WINDOW_SECURITY_PREFERENCES = Object.freeze({
  /** Renderer JS and Electron APIs live in separate contexts (the AC's law). */
  contextIsolation: true,
  /** The renderer runs in an OS sandbox with no Node.js available (the AC's law). */
  sandbox: true,
  /** Same-origin policy, secure-content, and navigation security stay enforced (the AC's law). */
  webSecurity: true,
  /** No Node APIs in the renderer (the AC's law). */
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  /** `<webview>` is inert — guests are denied before attach (the AC's law). */
  webviewTag: false,
  /** No preload: there is no bridge to expose (the no-bridge law). */
  preload: undefined,
});

/** Every permission Electron may ask about — denied wholesale; a future permission stays denied because no allowlist exists. */
export type PermissionRequestName = string;

/** The denial result every permission decision returns — there is no allowlist to drift from. */
export const PERMISSION_DECISION = Object.freeze({ granted: false });

/**
 * Evidence hooks for the denials (the smoke lane's observation surface):
 * pure recorders with zero decision power — the decisions are the
 * handlers' own, the hooks only report that they fired.
 */
export interface SessionSecurityEvidence {
  onPermissionRequestDenied?(permission: PermissionRequestName): void;
  onPermissionCheckDenied?(permission: PermissionRequestName): void;
  onDevicePermissionDenied?(): void;
  onDownloadDenied?(): void;
}

/** The session slice the policy installs its denials on — the Electron seam, injected; unit-tested with fakes. */
export interface SessionSecuritySeam {
  /** Installs the permission-request denial handler. */
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: PermissionRequestName,
      callback: (grant: { granted: boolean }) => void,
      details: unknown,
    ) => void,
  ): void;
  /** Installs the synchronous permission-check denial handler. */
  setPermissionCheckHandler(
    handler: (webContents: unknown, permission: PermissionRequestName, origin: string) => boolean,
  ): void;
  /** Installs the device-permission denial handler (media devices granted outside the request path). */
  setDevicePermissionHandler(handler: (deviceDetails: unknown) => boolean): void;
  /** Installs the will-download denial observer. */
  onWillDownload(handler: (event: { preventDefault(): void }, item: unknown) => void): void;
}

/**
 * Installs the session-wide denial surface: every permission request,
 * every permission check, every device permission, and every download is
 * denied. The evidence hooks (optional, the smoke lane's observation)
 * record that the denials fired; they never change any decision.
 */
export function applySessionSecurityPolicy(
  session: SessionSecuritySeam,
  evidence?: SessionSecurityEvidence,
): void {
  session.setPermissionRequestHandler((_webContents, permission, callback, _details) => {
    evidence?.onPermissionRequestDenied?.(permission);
    callback(PERMISSION_DECISION);
  });
  session.setPermissionCheckHandler((_webContents, permission, _origin) => {
    evidence?.onPermissionCheckDenied?.(permission);
    return false;
  });
  session.setDevicePermissionHandler((_deviceDetails) => {
    evidence?.onDevicePermissionDenied?.();
    return false;
  });
  session.onWillDownload((event, _item) => {
    event.preventDefault();
    evidence?.onDownloadDenied?.();
  });
}

/** The sanitized evidence counts the smoke lane asserts on. */
export interface SecurityDenialCounts {
  permissionRequests: number;
  permissionChecks: number;
  devicePermissions: number;
  downloads: number;
}

/** One recorder plus its evidence hooks — pure counting, zero decision power. */
export interface SecurityDenialRecorder {
  readonly evidence: SessionSecurityEvidence;
  counts(): SecurityDenialCounts;
}

export function createSecurityDenialRecorder(): SecurityDenialRecorder {
  let permissionRequests = 0;
  let permissionChecks = 0;
  let devicePermissions = 0;
  let downloads = 0;
  return {
    evidence: {
      onPermissionRequestDenied: () => {
        permissionRequests += 1;
      },
      onPermissionCheckDenied: () => {
        permissionChecks += 1;
      },
      onDevicePermissionDenied: () => {
        devicePermissions += 1;
      },
      onDownloadDenied: () => {
        downloads += 1;
      },
    },
    counts: () => ({ permissionRequests, permissionChecks, devicePermissions, downloads }),
  };
}
