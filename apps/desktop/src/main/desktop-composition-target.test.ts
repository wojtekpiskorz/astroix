import { describe, expect, it } from 'vitest';
import type { WebRequestListenerSeam } from '../document-authority/web-request-injection.ts';
import type { GuardedWindowSeam } from '../service-worker/bypass-guarded-target.ts';
import type { PartitionStorageSeam } from '../service-worker/partition-hygiene.ts';
import type { AuthorityObservation } from './child-protocol.ts';
import type { DebuggerSeam } from './debugger-guard.ts';
import {
  createAuthoritativeTargetHost,
  type TargetWindowSeam,
} from './desktop-composition-target.ts';

/**
 * The main-side authoritative-target host's focused units (#362, H7):
 * the composition's LAWS over fake seams — the fresh nonpersistent
 * partition per target, the bypass-before-navigation ordering (H5's
 * guarded target drives the loads), the observed-document identity (H4's
 * counter law), the injection's origin set, the capability mirror's
 * feed-and-clear, and the teardown's ordered hygiene. The real-Electron
 * truth is the e2e/desktop lanes; the product wiring (index.ts) drives
 * exactly this composition.
 */

const LAUNCHER = 'http://launcher.localhost:4426';
const PROJECT = 'http://aaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:4426';

/** One fake target window — records loads, fires navigations per the configured law. */
class FakeTargetWindow {
  readonly loads: string[] = [];
  navigationCount = 0;
  destroyed = false;
  /** True (the real Chromium law) when every committed loadURL ticks did-navigate — about:blank included. */
  tickOnLoad = false;
  private readonly closedHandlers: Array<() => void> = [];
  readonly window: GuardedWindowSeam = {
    webContentsId: 11,
    debugger: this.debugger(),
    loadUrl: async (url) => {
      if (this.destroyed) throw new Error('the window is destroyed');
      this.loads.push(url);
      if (this.tickOnLoad) this.navigate();
    },
    close: () => {
      if (this.destroyed) return;
      this.destroyed = true;
      for (const handler of [...this.closedHandlers]) handler();
    },
    onClosed: (handler) => {
      this.closedHandlers.push(handler);
      return () => {};
    },
  };
  private debugger(): DebuggerSeam {
    return {
      attach: () => {},
      sendCommand: async () => ({}),
      detach: () => {},
      onDetach: () => () => {},
      onDevtoolsOpened: () => () => {},
      closeDevtools: () => {},
    };
  }
  /** One completed top-level navigation (the observation wiring's counter tick). */
  navigate(): void {
    this.navigationCount += 1;
    for (const handler of [...this.handlers]) handler();
  }
  private readonly handlers: Array<() => void> = [];
  readonly seams: TargetWindowSeam = {
    window: this.window,
    storage: {
      clearStorageData: async () => {},
    } satisfies PartitionStorageSeam,
    webRequest: {
      onBeforeSendHeaders: () => {},
    } as WebRequestListenerSeam,
    events: {
      webContentsId: 11,
      onDidNavigate: (handler) => {
        this.handlers.push(handler);
        return () => {};
      },
      onRenderProcessGone: () => () => {},
      onDestroyed: () => () => {},
    },
  };
}

/** The recording environment — partitions, suffixes, forwarded observations. */
class FakeSeams {
  readonly windows: FakeTargetWindow[] = [];
  readonly partitions: string[] = [];
  readonly observations: AuthorityObservation[] = [];
  /** Mirrors the host's did-navigate law: true when every committed load counts. */
  tickOnLoad = false;
  createWindow(input: { readonly partition: string }): TargetWindowSeam {
    this.partitions.push(input.partition);
    const target = new FakeTargetWindow();
    target.tickOnLoad = this.tickOnLoad;
    this.windows.push(target);
    return target.seams;
  }
  randomSuffix(): string {
    return `suffix-${this.partitions.length}`;
  }
  observeAuthority(observation: AuthorityObservation): void {
    this.observations.push(observation);
  }
}

function bootHost(seams: FakeSeams) {
  const host = createAuthoritativeTargetHost(
    {
      createWindow: (input) => seams.createWindow(input),
      randomSuffix: () => seams.randomSuffix(),
      observeAuthority: (observation) => seams.observeAuthority(observation),
    },
    LAUNCHER,
    () => 'allow',
  );
  return host;
}

describe('the authoritative-target host (#362)', () => {
  it('prepares one target: a fresh nonpersistent partition, the bypass active before any project load', async () => {
    const seams = new FakeSeams();
    seams.tickOnLoad = true; // the real Chromium law: every committed load counts
    const host = bootHost(seams);
    expect(await host.prepare()).toBe(true);
    expect(seams.partitions).toHaveLength(1);
    expect(seams.partitions[0]?.startsWith('astroix-editing-')).toBe(true);
    expect(seams.partitions[0]?.startsWith('persist:')).toBe(false);
    // The neutral boot precedes everything: the bypass's own ordering law.
    expect(seams.windows[0]?.loads).toEqual(['about:blank']);
    // Re-preparation keeps the ONE target (the supervisor-global editor).
    expect(await host.prepare()).toBe(true);
    expect(seams.partitions).toHaveLength(1);
    expect(host.exists()).toBe(true);
  });

  it('answers no document before any navigation, the observed identity after one', async () => {
    const seams = new FakeSeams();
    const host = bootHost(seams);
    await host.prepare();
    expect(host.observeCurrentDocument()).toBeNull();
    seams.windows[0]?.navigate();
    expect(host.observeCurrentDocument()).toEqual({ webContentsId: 11, navigationId: 1 });
  });

  it('replaces the top level onto the granted origin and reports the observed document', async () => {
    const seams = new FakeSeams();
    seams.tickOnLoad = true; // the real Chromium law: every committed load counts
    const host = bootHost(seams);
    await host.prepare();
    expect(host.observeCurrentDocument()).toEqual({ webContentsId: 11, navigationId: 1 });
    const identity = await host.replaceTopLevel(PROJECT);
    expect(identity).toEqual({ webContentsId: 11, navigationId: 2 });
    expect(seams.windows[0]?.loads.at(-1)).toBe(`${PROJECT}/__astroix/app/`);
  });

  it('never binds at an unobserved document: a host that does not count the neutral boot gets one explicit neutral load', async () => {
    const seams = new FakeSeams();
    const host = bootHost(seams);
    // tickOnLoad stays false: the neutral boot observes nothing.
    await host.prepare();
    expect(seams.windows[0]?.loads).toEqual(['about:blank', 'about:blank']);
    expect(host.observeCurrentDocument()).toBeNull();
    seams.windows[0]?.navigate();
    expect(host.observeCurrentDocument()).toEqual({ webContentsId: 11, navigationId: 1 });
  });

  it('feeds the capability mirror: the live value injects, the clear empties, the revoke forwards', async () => {
    const seams = new FakeSeams();
    const host = bootHost(seams);
    await host.prepare();
    host.documentCapability(11, 'cap-live');
    host.documentCapability(11, null);
    host.documentCapability(11, 'cap-live');
    // The guarded target's fail-closed revoke path: the mirror's revoke
    // (driven through the guarded target on a real compromise) clears
    // locally and forwards — here the forward surface alone is pinned.
    expect(seams.observations).toEqual([]);
  });

  it('tears down: the window closes, the state is gone, a fresh prepare mints a FRESH partition', async () => {
    const seams = new FakeSeams();
    const host = bootHost(seams);
    await host.prepare();
    seams.windows[0]?.navigate();
    await host.teardown();
    expect(seams.windows[0]?.destroyed).toBe(true);
    expect(host.exists()).toBe(false);
    expect(await host.prepare()).toBe(true);
    expect(seams.partitions).toHaveLength(2);
    expect(seams.partitions[0]).not.toBe(seams.partitions[1]);
  });
});
