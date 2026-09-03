import type { DocumentAuthorityPort } from '@wojciechpiskorz/astroix-runtime/client-authority';
import { describe, expect, it } from 'vitest';
import { type DocumentTargetEventsSeam, observeDocumentTarget } from './document-bindings.ts';

/**
 * The document-binding lifecycle's focused units (#246): a recording
 * fake of the authority port and a hand-raised event seam — the
 * navigation counter's monotonic ticks, the renderer-loss and
 * destruction mappings, and detach. The real Electron events driving
 * the same port is the `e2e/desktop` lane's proof.
 */

interface PortRecording {
  readonly port: DocumentAuthorityPort;
  navigated(): ReadonlyArray<{ webContentsId: number; navigationId: number }>;
  lost(): readonly number[];
  destroyed(): readonly number[];
}

function fakePort(): PortRecording {
  const navigations: { webContentsId: number; navigationId: number }[] = [];
  const lost: number[] = [];
  const destroyed: number[] = [];
  return {
    port: {
      injectableCapability: () => null,
      documentNavigated: (webContentsId, navigationId) => {
        navigations.push({ webContentsId, navigationId });
      },
      rendererLost: (webContentsId) => {
        lost.push(webContentsId);
      },
      targetDestroyed: (webContentsId) => {
        destroyed.push(webContentsId);
      },
    },
    navigated: () => navigations,
    lost: () => lost,
    destroyed: () => destroyed,
  };
}

/** The hand-raised event seam: fire functions plus registration counts. */
function fakeTarget(webContentsId: number): {
  target: DocumentTargetEventsSeam;
  fireDidNavigate(): void;
  fireRenderProcessGone(): void;
  fireDestroyed(): void;
  listenerCount(): number;
} {
  const didNavigate: (() => void)[] = [];
  const renderGone: (() => void)[] = [];
  const destroyed: (() => void)[] = [];
  return {
    target: {
      webContentsId,
      onDidNavigate: (handler) => {
        didNavigate.push(handler);
        return () => {
          const at = didNavigate.indexOf(handler);
          if (at !== -1) didNavigate.splice(at, 1);
        };
      },
      onRenderProcessGone: (handler) => {
        renderGone.push(handler);
        return () => {
          const at = renderGone.indexOf(handler);
          if (at !== -1) renderGone.splice(at, 1);
        };
      },
      onDestroyed: (handler) => {
        destroyed.push(handler);
        return () => {
          const at = destroyed.indexOf(handler);
          if (at !== -1) destroyed.splice(at, 1);
        };
      },
    },
    fireDidNavigate: () => {
      for (const handler of [...didNavigate]) handler();
    },
    fireRenderProcessGone: () => {
      for (const handler of [...renderGone]) handler();
    },
    fireDestroyed: () => {
      for (const handler of [...destroyed]) handler();
    },
    listenerCount: () => didNavigate.length + renderGone.length + destroyed.length,
  };
}

describe('observeDocumentTarget — the host-driven invalidation wiring', () => {
  it('counts top-level navigations monotonically from 1 and reports each to the port', () => {
    const world = fakePort();
    const target = fakeTarget(11);
    const binding = observeDocumentTarget(world.port, target.target);
    expect(binding.currentNavigationId()).toBe(0);
    target.fireDidNavigate();
    target.fireDidNavigate();
    target.fireDidNavigate();
    expect(world.navigated()).toEqual([
      { webContentsId: 11, navigationId: 1 },
      { webContentsId: 11, navigationId: 2 },
      { webContentsId: 11, navigationId: 3 },
    ]);
    expect(binding.currentNavigationId()).toBe(3);
  });

  it('maps renderer loss and target destruction onto the port unchanged', () => {
    const world = fakePort();
    const target = fakeTarget(11);
    observeDocumentTarget(world.port, target.target);
    target.fireRenderProcessGone();
    target.fireDestroyed();
    expect(world.lost()).toEqual([11]);
    expect(world.destroyed()).toEqual([11]);
    // A navigation after renderer loss still counts monotonically — the
    // reload's new document is a NEW navigation identity.
    target.fireDidNavigate();
    expect(world.navigated()).toEqual([{ webContentsId: 11, navigationId: 1 }]);
  });

  it('detaches every listener — later events never reach the port', () => {
    const world = fakePort();
    const target = fakeTarget(11);
    const binding = observeDocumentTarget(world.port, target.target);
    expect(target.listenerCount()).toBe(3);
    binding.detach();
    expect(target.listenerCount()).toBe(0);
    target.fireDidNavigate();
    target.fireRenderProcessGone();
    target.fireDestroyed();
    expect(world.navigated()).toEqual([]);
    expect(world.lost()).toEqual([]);
    expect(world.destroyed()).toEqual([]);
    expect(binding.currentNavigationId()).toBe(0);
  });
});
