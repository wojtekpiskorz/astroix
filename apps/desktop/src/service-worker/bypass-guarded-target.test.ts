import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { createClientBindings } from '@wojciechpiskorz/astroix-runtime/api/http';
import {
  createDocumentAuthority,
  type DocumentAuthority,
} from '@wojciechpiskorz/astroix-runtime/client-authority';
import { createSessionClients } from '@wojciechpiskorz/astroix-runtime/session-supervisor/clients';
import { describe, expect, it } from 'vitest';
import type { DebuggerSeam } from '../main/debugger-guard.ts';
import { createGuardedTarget, type GuardedWindowSeam } from './bypass-guarded-target.ts';
import type { PartitionStorageSeam } from './partition-hygiene.ts';

/**
 * The bypass-guarded target's focused units (#247, H5): the
 * composition over a fake window/debugger and the REAL runtime
 * document authority (H4's both-truths surface — the same idiom as the
 * runtime seam's own units): the ordering gate (no navigation, no
 * editor authority before the bypass), the fail-closed revocation on
 * every failure kind, the recovery rebind, and the close-then-clean
 * hygiene ordering. The real-Electron truth is the `e2e/desktop` lane.
 */

const SESSION: SessionRef = { runtimeEpoch: 'unit-epoch', generation: 1 };
const PROJECT_KEY = 'abcdefghijklmnopqrstuvwxyz';
const ORIGIN = 'http://a.localhost:4321';

/** The fake window: close() marks it closed; the closed event is hand-fired. */
function fakeWindow(): {
  seam: GuardedWindowSeam & { fireDetach(reason: string): void; fireClosed(): void };
  loadedUrls(): string[];
  closed(): boolean;
} {
  const loadedUrls: string[] = [];
  const detachHandlers: ((reason: string) => void)[] = [];
  const closedHandlers: (() => void)[] = [];
  let isClosed = false;
  return {
    seam: {
      webContentsId: 41,
      debugger: {
        attach: () => {},
        sendCommand: () => Promise.resolve({}),
        detach: () => {},
        onDetach: (handler) => {
          detachHandlers.push(handler);
          return () => {
            const at = detachHandlers.indexOf(handler);
            if (at !== -1) detachHandlers.splice(at, 1);
          };
        },
        onDevtoolsOpened: () => () => {},
        closeDevtools: () => {},
      },
      loadUrl: async (url) => {
        if (isClosed) throw new Error('window is closed');
        loadedUrls.push(url);
      },
      close: () => {
        isClosed = true;
      },
      onClosed: (handler) => {
        closedHandlers.push(handler);
        return () => {
          const at = closedHandlers.indexOf(handler);
          if (at !== -1) closedHandlers.splice(at, 1);
        };
      },
      fireDetach: (reason) => {
        for (const handler of [...detachHandlers]) handler(reason);
      },
      fireClosed: () => {
        for (const handler of [...closedHandlers]) handler();
      },
    },
    loadedUrls: () => [...loadedUrls],
    closed: () => isClosed,
  };
}

/** The recording storage fake. */
function fakeStorage(): { seam: PartitionStorageSeam; clearCalls(): readonly string[][] } {
  const calls: string[][] = [];
  return {
    seam: {
      clearStorageData: async (options) => {
        calls.push([...options.storages]);
      },
    },
    clearCalls: () => [...calls],
  };
}

/** One composition over the REAL runtime authority (fresh tables per test). */
function setup(): {
  window: ReturnType<typeof fakeWindow>;
  storage: ReturnType<typeof fakeStorage>;
  authority: DocumentAuthority;
  target: ReturnType<typeof createGuardedTarget>;
  unready: { kind: string; detail: string }[];
} {
  const window = fakeWindow();
  const storage = fakeStorage();
  const authority = createDocumentAuthority({
    httpBindings: createClientBindings(),
    clients: createSessionClients(),
  });
  const unready: { kind: string; detail: string }[] = [];
  const target = createGuardedTarget({
    window: window.seam,
    authority,
    storage: storage.seam,
    onUnready: (failure) => {
      unready.push({ kind: failure.kind, detail: failure.detail });
    },
  });
  return { window, storage, authority, target, unready };
}

/** The host-side navigation observation the harness wires (H4's observeDocumentTarget shape). */
function observedNavigation(authority: DocumentAuthority, navigationId: number): number {
  authority.documentNavigated(41, navigationId);
  return navigationId;
}

describe('createGuardedTarget — the ordering law', () => {
  it('refuses navigation and editor binds before the bypass is live, loading nothing', async () => {
    const { target, authority, window } = setup();
    const navigation = observedNavigation(authority, 1);
    expect(await target.loadProjectOrigin(`${ORIGIN}/`)).toEqual({
      kind: 'refused',
      reason: 'bypass-not-active',
    });
    expect(window.loadedUrls()).toEqual([]);
    expect(
      target.bindEditor({ sessionRef: SESSION, projectKey: PROJECT_KEY, navigationId: navigation }),
    ).toEqual({ kind: 'refused', reason: 'bypass-not-active' });
    expect(authority.grants()).toHaveLength(0);
    expect(target.actions()).toEqual(['navigation-refused', 'editor-bind-refused']);
  });

  it('navigates and binds only after the full bypass sequence, in logged order', async () => {
    const { target, authority } = setup();
    expect(await target.activateBypass()).toBe(true);
    expect(await target.loadProjectOrigin(`${ORIGIN}/`)).toEqual({ kind: 'loaded' });
    const navigation = observedNavigation(authority, 1);
    const bound = target.bindEditor({
      sessionRef: SESSION,
      projectKey: PROJECT_KEY,
      navigationId: navigation,
    });
    expect(bound.kind).toBe('bound');
    if (bound.kind === 'bound') {
      expect(authority.injectableCapability(41)).toBe(bound.capability);
    }
    expect(target.actions()).toEqual([
      'neutral-boot-loaded',
      'attached',
      'network-enabled',
      'bypass-set',
      'bypass-active',
      'navigation-started',
      'navigation-settled',
      'editor-bound',
    ]);
  });
});

describe('createGuardedTarget — the fail-closed law', () => {
  it('revokes document authority when the debugger detaches mid-session (the DevTools law)', async () => {
    const { target, authority, window, unready } = setup();
    await target.activateBypass();
    await target.loadProjectOrigin(`${ORIGIN}/`);
    const navigation = observedNavigation(authority, 1);
    const bound = target.bindEditor({
      sessionRef: SESSION,
      projectKey: PROJECT_KEY,
      navigationId: navigation,
    });
    expect(bound.kind).toBe('bound');
    // DevTools invoked: the real detach event fires with its reason.
    window.seam.fireDetach('Other debugger is attached');
    expect(authority.injectableCapability(41)).toBeNull();
    expect(unready).toEqual([{ kind: 'debugger-detached', detail: 'Other debugger is attached' }]);
    expect(target.readiness()).toEqual({
      ready: false,
      guardState: 'compromised',
      failure: { kind: 'debugger-detached', detail: 'Other debugger is attached' },
    });
    // Both later control steps refuse — editing disabled before another request.
    expect(await target.loadProjectOrigin(`${ORIGIN}/?next`)).toEqual({
      kind: 'refused',
      reason: 'bypass-not-active',
    });
    expect(
      target.bindEditor({ sessionRef: SESSION, projectKey: PROJECT_KEY, navigationId: navigation }),
    ).toEqual({ kind: 'refused', reason: 'bypass-not-active' });
    expect(target.actions()).toContain('authority-revoked');
    expect(target.actions()).toContain('compromised');
  });

  it('stays unready (never binds, never loads) when activation itself fails', async () => {
    const window = fakeWindow();
    // An attach that refuses — DevTools already holds the target.
    const occupiedDebugger: DebuggerSeam = {
      attach: () => {
        throw new Error('Another debugger is already attached');
      },
      sendCommand: () => Promise.resolve({}),
      detach: () => {},
      onDetach: window.seam.debugger.onDetach,
      onDevtoolsOpened: () => () => {},
      closeDevtools: () => {},
    };
    const authority = createDocumentAuthority({
      httpBindings: createClientBindings(),
      clients: createSessionClients(),
    });
    const unready: string[] = [];
    const target = createGuardedTarget({
      window: { ...window.seam, debugger: occupiedDebugger },
      authority,
      storage: fakeStorage().seam,
      onUnready: (failure) => {
        unready.push(failure.kind);
      },
    });
    expect(await target.activateBypass()).toBe(false);
    expect(unready).toEqual(['attach-failed']);
    expect(await target.loadProjectOrigin(`${ORIGIN}/`)).toEqual({
      kind: 'refused',
      reason: 'bypass-not-active',
    });
    // Only the neutral boot document loaded — no project URL ever did.
    expect(window.loadedUrls()).toEqual(['about:blank']);
    expect(authority.grants()).toHaveLength(0);
    expect(target.readiness().guardState).toBe('compromised');
  });

  it('recovers on the reloaded target: re-activation restores the bypass and a fresh bind', async () => {
    const { target, authority, window, unready } = setup();
    await target.activateBypass();
    await target.loadProjectOrigin(`${ORIGIN}/`);
    observedNavigation(authority, 1);
    const first = target.bindEditor({
      sessionRef: SESSION,
      projectKey: PROJECT_KEY,
      navigationId: 1,
    });
    expect(first.kind).toBe('bound');
    const firstCapability = first.kind === 'bound' ? first.capability : '';
    window.seam.fireDetach('DevTools invoked');
    expect(unready).toHaveLength(1);
    // Recovery: the reloaded target re-activates the bypass, then binds
    // FRESH authority at the new navigation — never the old capability.
    expect(await target.activateBypass()).toBe(true);
    expect(await target.loadProjectOrigin(`${ORIGIN}/?reloaded`)).toEqual({ kind: 'loaded' });
    const navigation = observedNavigation(authority, 2);
    const second = target.bindEditor({
      sessionRef: SESSION,
      projectKey: PROJECT_KEY,
      navigationId: navigation,
    });
    expect(second.kind).toBe('bound');
    if (second.kind === 'bound') {
      expect(second.capability).not.toBe(firstCapability);
      expect(authority.injectableCapability(41)).toBe(second.capability);
    }
  });
});

describe('createGuardedTarget — the hygiene law', () => {
  it('clears the partition only after the real unload event, then reports', async () => {
    const { target, window, storage } = setup();
    await target.activateBypass();
    await target.loadProjectOrigin(`${ORIGIN}/`);
    const cleaning = target.closeAndClean();
    // The window is closed, but its closed event has not fired yet: no clear.
    expect(window.closed()).toBe(true);
    await Promise.resolve();
    expect(storage.clearCalls()).toHaveLength(0);
    window.seam.fireClosed();
    expect(await cleaning).toEqual({ ok: true, storages: ['serviceworkers', 'cachestorage'] });
    expect(target.actions().slice(-2)).toEqual(['partition-hygiene-cleared', 'target-closed']);
  });

  it('is idempotent: a second closeAndClean returns the first report, clears once', async () => {
    const { target, window, storage } = setup();
    await target.activateBypass();
    const first = target.closeAndClean();
    window.seam.fireClosed();
    expect(await first).toEqual({ ok: true, storages: ['serviceworkers', 'cachestorage'] });
    expect(await target.closeAndClean()).toEqual(await first);
    expect(storage.clearCalls()).toHaveLength(1);
  });

  it("revokes remaining authority at close (belt and braces beside H4's own observation)", async () => {
    const { target, authority, window } = setup();
    await target.activateBypass();
    await target.loadProjectOrigin(`${ORIGIN}/`);
    observedNavigation(authority, 1);
    expect(
      target.bindEditor({ sessionRef: SESSION, projectKey: PROJECT_KEY, navigationId: 1 }).kind,
    ).toBe('bound');
    const closing = target.closeAndClean();
    expect(authority.injectableCapability(41)).toBeNull();
    window.seam.fireClosed();
    expect(await closing).toEqual({ ok: true, storages: ['serviceworkers', 'cachestorage'] });
  });
});
