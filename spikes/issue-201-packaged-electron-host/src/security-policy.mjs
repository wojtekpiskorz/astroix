export function createHardenedWindowOptions() {
  return {
    show: false,
    webPreferences: {
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
    },
  };
}

export function isAllowedMainFrameNavigation(targetUrl, activeOrigin) {
  try {
    const target = new URL(targetUrl);
    const active = new URL(activeOrigin);
    return (
      target.username === '' &&
      target.password === '' &&
      target.protocol === 'http:' &&
      target.origin === active.origin &&
      target.pathname === '/__astroix/app/'
    );
  } catch {
    return false;
  }
}

export function createMainFrameNavigationPolicy(initialOrigin) {
  let activeOrigin = new URL(initialOrigin).origin;
  let pendingOrigin;
  let inFlightOrigin;

  return {
    activeOrigin: () => activeOrigin,
    permitTransition(nextOrigin) {
      const parsed = new URL(nextOrigin);
      if (
        parsed.protocol !== 'http:' ||
        !parsed.hostname.endsWith('.localhost') ||
        parsed.username !== '' ||
        parsed.password !== ''
      ) {
        throw new Error(`invalid project transition origin: ${nextOrigin}`);
      }
      if (pendingOrigin !== undefined || inFlightOrigin !== undefined) {
        throw new Error('a project transition is already pending');
      }
      pendingOrigin = parsed.origin;
    },
    allow(targetUrl) {
      if (isAllowedMainFrameNavigation(targetUrl, activeOrigin)) return true;
      if (pendingOrigin !== undefined && isAllowedMainFrameNavigation(targetUrl, pendingOrigin)) {
        inFlightOrigin = pendingOrigin;
        pendingOrigin = undefined;
        return true;
      }
      return false;
    },
    commitTransition(targetUrl) {
      if (
        inFlightOrigin === undefined ||
        !isAllowedMainFrameNavigation(targetUrl, inFlightOrigin)
      ) {
        return false;
      }
      activeOrigin = inFlightOrigin;
      inFlightOrigin = undefined;
      return true;
    },
    cancelTransition() {
      if (pendingOrigin === undefined && inFlightOrigin === undefined) return false;
      pendingOrigin = undefined;
      inFlightOrigin = undefined;
      return true;
    },
  };
}
