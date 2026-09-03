import { describe, expect, it } from 'vitest';
import {
  applySessionSecurityPolicy,
  createSecurityDenialRecorder,
  type SessionSecuritySeam,
  WINDOW_SECURITY_PREFERENCES,
} from './security-policy.ts';

/**
 * The security posture's focused units (#243): the frozen preference
 * block and every session-wide denial — permission request, permission
 * check, device permission, and download — against a recording seam. The
 * real-Electron evidence is the smoke lane.
 */
describe('WINDOW_SECURITY_PREFERENCES', () => {
  it('pins the AC law: isolation and sandbox on, webSecurity on, every nodeIntegration off, webviews off', () => {
    expect(WINDOW_SECURITY_PREFERENCES).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
    });
    expect(Object.isFrozen(WINDOW_SECURITY_PREFERENCES)).toBe(true);
  });

  it('carries no preload — there is no bridge to expose', () => {
    expect(WINDOW_SECURITY_PREFERENCES.preload).toBeUndefined();
  });
});

/** Records the handlers the policy installs — the fake seam. */
class RecordingSession {
  granted: Array<{ granted: boolean }> = [];
  checks: boolean[] = [];
  devices: boolean[] = [];
  downloads: number = 0;
  prevented: number = 0;
  readonly seam: SessionSecuritySeam = {
    setPermissionRequestHandler: (handler) => {
      this.permissionRequest = handler;
    },
    setPermissionCheckHandler: (handler) => {
      this.permissionCheck = handler;
    },
    setDevicePermissionHandler: (handler) => {
      this.devicePermission = handler;
    },
    onWillDownload: (handler) => {
      this.willDownload = handler;
    },
  };
  permissionRequest: (
    webContents: unknown,
    permission: string,
    callback: (grant: { granted: boolean }) => void,
    details: unknown,
  ) => void = () => {};
  permissionCheck: (webContents: unknown, permission: string, origin: string) => boolean = () =>
    true;
  devicePermission: (details: unknown) => boolean = () => true;
  willDownload: (event: { preventDefault(): void }, item: unknown) => void = () => {};
}

describe('applySessionSecurityPolicy', () => {
  it('installs all four denial handlers', () => {
    const session = new RecordingSession();
    applySessionSecurityPolicy(session.seam);
    expect(session.permissionRequest).not.toBe(() => {});
    expect(session.permissionCheck).toBeDefined();
    expect(session.devicePermission).toBeDefined();
    expect(session.willDownload).toBeDefined();
  });

  it('denies every permission request — any name, including unknown future permissions', () => {
    const session = new RecordingSession();
    applySessionSecurityPolicy(session.seam);
    for (const permission of [
      'geolocation',
      'media',
      'notifications',
      'clipboard-read',
      'future-permission',
    ]) {
      session.permissionRequest({}, permission, (grant) => session.granted.push(grant), {});
    }
    expect(session.granted).toHaveLength(5);
    expect(session.granted.every((grant) => grant.granted === false)).toBe(true);
  });

  it('denies every synchronous permission check and every device permission', () => {
    const session = new RecordingSession();
    applySessionSecurityPolicy(session.seam);
    expect(session.permissionCheck({}, 'media', 'http://launcher.localhost:4430')).toBe(false);
    expect(session.permissionCheck({}, 'full-screen', 'https://anywhere.example')).toBe(false);
    expect(session.devicePermission({ device: 'usb' })).toBe(false);
  });

  it('prevents every download and reports each denial to the evidence recorder', () => {
    const session = new RecordingSession();
    const recorder = createSecurityDenialRecorder();
    applySessionSecurityPolicy(session.seam, recorder.evidence);
    session.willDownload({ preventDefault: () => (session.prevented += 1) }, {});
    session.willDownload({ preventDefault: () => (session.prevented += 1) }, {});
    expect(session.prevented).toBe(2);
    expect(recorder.counts().downloads).toBe(2);
  });

  it('records every permission request, check, and device denial through the evidence hooks', () => {
    const session = new RecordingSession();
    const recorder = createSecurityDenialRecorder();
    applySessionSecurityPolicy(session.seam, recorder.evidence);
    session.permissionRequest({}, 'notifications', (grant) => session.granted.push(grant), {});
    session.permissionRequest({}, 'media', (grant) => session.granted.push(grant), {});
    session.permissionCheck({}, 'geolocation', 'http://launcher.localhost:4430');
    session.devicePermission({});
    expect(recorder.counts()).toEqual({
      permissionRequests: 2,
      permissionChecks: 1,
      devicePermissions: 1,
      downloads: 0,
    });
    expect(session.granted.every((grant) => grant.granted === false)).toBe(true);
  });
});
