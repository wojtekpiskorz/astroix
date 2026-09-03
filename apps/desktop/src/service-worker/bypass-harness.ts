import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { createClientBindings } from '@wojciechpiskorz/astroix-runtime/api/http';
import {
  createDocumentAuthority,
  type DocumentAuthority,
} from '@wojciechpiskorz/astroix-runtime/client-authority';
import { createSessionClients } from '@wojciechpiskorz/astroix-runtime/session-supervisor/clients';
import { app, BrowserWindow, type Session, session } from 'electron';
import type { DebuggerSeam } from '../main/debugger-guard.ts';
import { observeDocumentTarget } from '../main/document-bindings.ts';
import { createEditingPartitionMinter } from '../main/editing-partition.ts';
import { WINDOW_SECURITY_PREFERENCES } from '../main/security-policy.ts';
import {
  createGuardedTarget,
  type GuardedTarget,
  type GuardedWindowSeam,
} from './bypass-guarded-target.ts';
import {
  CANVAS_STATE_SCRIPT,
  fetchProbeScript,
  HMR_STATE_SCRIPT,
  REGISTER_HOSTILE_SW_SCRIPT,
  SSE_PROBE_SCRIPT,
  SW_STATE_SCRIPT,
} from './bypass-probes.ts';
import type { PartitionStorageSeam } from './partition-hygiene.ts';

/**
 * The service-worker bypass real-Electron harness (#247, H5 focused
 * lane): a TEST main-process entry — never the product composition,
 * never release evidence (ADR-0008) — that composes the REAL surfaces
 * this lane owns over the REAL Electron 44.1.0 binary: the fresh
 * nonpersistent editing partitions (`session.fromPartition`), the CDP
 * debugger guard over the real `webContents.debugger` (attach 1.3,
 * Network.enable, Network.setBypassServiceWorker), the bypass-guarded
 * target composition over the REAL runtime document authority (H4),
 * and the post-unload partition hygiene — against a REAL Vite dev
 * server origin serving a genuinely hostile root Service Worker.
 *
 * What only this lane can prove, because only the real Chromium
 * network stack has the property: a live, activated, fetch-intercepting
 * root SW on the authoritative origin cannot intercept app, API,
 * canvas, or SSE traffic while the bypass is live, while the native
 * Vite HMR WebSocket keeps working; DevTools and any debugger detach
 * revoke document authority fail-closed; and the partition hygiene
 * clears SW registrations and Cache Storage only after the old target
 * unloads.
 *
 * Protocol: one JSON object per stdin line (the command table in
 * `handle`), one `astroix-sw-harness: <json>` line per response on
 * stdout. The `raw` targets are UNPROTECTED control windows (no guard,
 * no minted partition of their own unless the lane names one) — the
 * lane's non-vacuity proof that the hostile SW really controls an
 * unprotected target on this origin.
 */

const SESSION: SessionRef = { runtimeEpoch: 'sw-harness-epoch', generation: 1 };
const PROJECT_KEY = 'abcdefghijklmnopqrstuvwxyz';

function report(event: Record<string, unknown>): void {
  console.log(`astroix-sw-harness: ${JSON.stringify(event)}`);
}

/** One command off the spec's stdin. */
type HarnessCommand =
  | {
      readonly op: 'open';
      readonly targetId: string;
      readonly mode: 'bypassed' | 'raw';
      readonly partition?: string;
    }
  | { readonly op: 'load'; readonly targetId: string; readonly url: string }
  | { readonly op: 'register-hostile-sw'; readonly targetId: string }
  | { readonly op: 'sw-state'; readonly targetId: string }
  | { readonly op: 'fetch-probe'; readonly targetId: string; readonly path: string }
  | { readonly op: 'sse-probe'; readonly targetId: string }
  | { readonly op: 'canvas-state'; readonly targetId: string }
  | { readonly op: 'hmr-state'; readonly targetId: string }
  | { readonly op: 'bind-editor'; readonly targetId: string }
  | { readonly op: 'authority-state'; readonly targetId: string }
  | { readonly op: 'open-devtools'; readonly targetId: string }
  | { readonly op: 'close-devtools'; readonly targetId: string }
  | { readonly op: 'detach-debugger'; readonly targetId: string }
  | { readonly op: 'reactivate'; readonly targetId: string }
  | { readonly op: 'close-target'; readonly targetId: string }
  | { readonly op: 'quit' };

/** One open target: a raw control window or a bypass-guarded editing target. */
interface OpenTarget {
  readonly targetId: string;
  readonly mode: 'bypassed' | 'raw';
  readonly partitionName: string;
  readonly win: BrowserWindow;
  readonly target?: GuardedTarget;
  /** The bypassed target's navigation counter view (H4's observeDocumentTarget binding). */
  readonly currentNavigationId?: () => number;
}

/** The structural adapter: the real `webContents.debugger` and DevTools events onto the guard's seam. */
function debuggerSeamOf(win: BrowserWindow): DebuggerSeam {
  const api = win.webContents.debugger;
  const wc = win.webContents;
  return {
    attach: (protocolVersion) => {
      api.attach(protocolVersion);
    },
    sendCommand: (method, params) => api.sendCommand(method, params) as Promise<unknown>,
    detach: () => {
      api.detach();
    },
    onDetach: (handler) => {
      const listener = (_event: unknown, reason: string): void => handler(reason);
      api.on('detach', listener);
      return () => {
        api.off('detach', listener);
      };
    },
    // The observed DevTools law (Electron 44.1.0): opening DevTools
    // neither detaches the debugger nor blocks it — the guard watches
    // the event itself.
    onDevtoolsOpened: (handler) => {
      const listener = (): void => handler();
      wc.on('devtools-opened', listener);
      return () => {
        wc.removeListener('devtools-opened', listener);
      };
    },
    closeDevtools: () => {
      wc.closeDevTools();
    },
  };
}

/** The structural adapter: the real BrowserWindow onto the guarded-target window seam. */
function windowSeamOf(win: BrowserWindow): GuardedWindowSeam {
  return {
    webContentsId: win.webContents.id,
    debugger: debuggerSeamOf(win),
    loadUrl: async (url) => {
      await win.webContents.loadURL(url);
    },
    close: () => {
      win.destroy();
    },
    onClosed: (handler) => {
      win.on('closed', handler);
      return () => {
        win.removeListener('closed', handler);
      };
    },
  };
}

async function main(): Promise<void> {
  await app.whenReady();
  // The harness main lives for its line protocol, not for its windows:
  // closing the last target window must not quit it (later legs open
  // fresh targets — Electron's default window-all-closed quit would
  // kill the lane mid-story).
  app.on('window-all-closed', () => {});

  // — the real runtime authority (H4's both-truths surface), fresh for the lane —
  const authority: DocumentAuthority = createDocumentAuthority({
    httpBindings: createClientBindings(),
    clients: createSessionClients(),
  });
  const minter = createEditingPartitionMinter(() => randomBytes(16).toString('hex'));
  /**
   * Every partition's session, opened once and retained until quit —
   * the app-side reference that keeps an in-memory partition's storage
   * alive across target unloads (the no-cleanup contrast leg depends
   * on it: an unreferenced in-memory session may die with its window,
   * which would make the cleanup proof vacuous).
   */
  const retainedSessions = new Map<string, Session>();
  const targets = new Map<string, OpenTarget>();

  function partitionSession(name: string): Session {
    const existing = retainedSessions.get(name);
    if (existing !== undefined) return existing;
    const opened = session.fromPartition(name);
    retainedSessions.set(name, opened);
    return opened;
  }

  function storageSeamOf(name: string): PartitionStorageSeam {
    const retained = partitionSession(name);
    return {
      // The mutable Electron storages array is derived here, at the
      // adapter — the pure modules stay readonly.
      clearStorageData: (options) =>
        retained.clearStorageData({
          storages: [...options.storages] as Electron.ClearStorageDataOptions['storages'],
        }),
    };
  }

  function requireTarget(targetId: string): OpenTarget {
    const target = targets.get(targetId);
    if (target === undefined) throw new Error(`unknown target: ${targetId}`);
    return target;
  }

  function requireGuarded(targetId: string): {
    target: GuardedTarget;
    navigationId: () => number;
    win: BrowserWindow;
  } {
    const entry = requireTarget(targetId);
    if (entry.target === undefined || entry.currentNavigationId === undefined) {
      throw new Error(`target ${targetId} is not bypass-guarded`);
    }
    return { target: entry.target, navigationId: entry.currentNavigationId, win: entry.win };
  }

  async function executeProbe(targetId: string, script: string, label: string): Promise<void> {
    const { win } = requireTarget(targetId);
    try {
      const result = await win.webContents.executeJavaScript(script);
      report({ kind: label, targetId, result });
    } catch (error) {
      report({
        kind: label,
        targetId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function open(command: Extract<HarnessCommand, { op: 'open' }>): Promise<void> {
    if (targets.has(command.targetId)) throw new Error(`target already open: ${command.targetId}`);
    const partitionName =
      command.partition !== undefined
        ? command.partition
        : command.mode === 'bypassed'
          ? minter.mint().name
          : `astroix-sw-harness-raw-${command.targetId}`;
    // Every partition the lane touches is nonpersistent (the editing-partition law).
    partitionSession(partitionName);
    const win = new BrowserWindow({
      title: `astroix sw harness — ${command.targetId}`,
      width: 480,
      height: 320,
      show: false,
      webPreferences: { ...WINDOW_SECURITY_PREFERENCES, partition: partitionName },
    });
    const entry: OpenTarget = {
      targetId: command.targetId,
      mode: command.mode,
      partitionName,
      win,
    };
    if (command.mode === 'raw') {
      targets.set(command.targetId, entry);
      report({
        kind: 'target-opened',
        targetId: command.targetId,
        mode: 'raw',
        partition: partitionName,
        webContentsId: win.webContents.id,
      });
      return;
    }
    const didNavigate = (handler: () => void): (() => void) => {
      const listener = (): void => handler();
      win.webContents.on('did-navigate', listener);
      return () => {
        win.webContents.removeListener('did-navigate', listener);
      };
    };
    const navigation = observeDocumentTarget(authority, {
      webContentsId: win.webContents.id,
      onDidNavigate: didNavigate,
      onRenderProcessGone: (handler) => {
        const listener = (): void => handler();
        win.webContents.on('render-process-gone', listener);
        return () => {
          win.webContents.removeListener('render-process-gone', listener);
        };
      },
      onDestroyed: (handler) => {
        const listener = (): void => handler();
        win.webContents.on('destroyed', listener);
        return () => {
          win.webContents.removeListener('destroyed', listener);
        };
      },
    });
    const target = createGuardedTarget({
      window: windowSeamOf(win),
      authority,
      storage: storageSeamOf(partitionName),
      onUnready: (failure) => {
        report({
          kind: 'target-unready',
          targetId: command.targetId,
          failureKind: failure.kind,
          detail: failure.detail,
        });
      },
    });
    targets.set(command.targetId, {
      ...entry,
      target,
      currentNavigationId: navigation.currentNavigationId,
    });
    report({
      kind: 'target-opened',
      targetId: command.targetId,
      mode: 'bypassed',
      partition: partitionName,
      webContentsId: win.webContents.id,
    });
    // The ordering law lives in the composition: the bypass activates
    // before the lane's first load command can even be admitted.
    const activated = await target.activateBypass();
    report({ kind: 'activation', targetId: command.targetId, ok: activated });
  }

  async function load(command: Extract<HarnessCommand, { op: 'load' }>): Promise<void> {
    const target = requireTarget(command.targetId);
    if (target.target !== undefined) {
      const outcome = await target.target.loadProjectOrigin(command.url);
      report({
        kind: 'loaded',
        targetId: command.targetId,
        outcome,
        url: target.win.webContents.getURL(),
      });
      return;
    }
    await target.win.webContents.loadURL(command.url);
    report({ kind: 'loaded', targetId: command.targetId, url: target.win.webContents.getURL() });
  }

  async function bindEditor(
    command: Extract<HarnessCommand, { op: 'bind-editor' }>,
  ): Promise<void> {
    const { target, navigationId } = requireGuarded(command.targetId);
    const current = navigationId();
    const outcome = target.bindEditor({
      sessionRef: SESSION,
      projectKey: PROJECT_KEY,
      navigationId: current,
    });
    report({
      kind: outcome.kind === 'bound' ? 'editor-bound' : 'editor-bind-refused',
      targetId: command.targetId,
      outcome,
      navigationId: current,
    });
  }

  async function authorityState(
    command: Extract<HarnessCommand, { op: 'authority-state' }>,
  ): Promise<void> {
    const { target, win } = requireGuarded(command.targetId);
    report({
      kind: 'authority-state',
      targetId: command.targetId,
      readiness: target.readiness(),
      injectable: authority.injectableCapability(win.webContents.id),
      actions: target.actions(),
    });
  }

  async function reactivate(command: Extract<HarnessCommand, { op: 'reactivate' }>): Promise<void> {
    const { target } = requireGuarded(command.targetId);
    const activated = await target.activateBypass();
    report({ kind: 'activation', targetId: command.targetId, ok: activated });
  }

  async function closeTarget(
    command: Extract<HarnessCommand, { op: 'close-target' }>,
  ): Promise<void> {
    const target = requireTarget(command.targetId);
    if (target.target !== undefined) {
      const hygiene = await target.target.closeAndClean();
      report({ kind: 'target-closed', targetId: command.targetId, hygiene });
    } else {
      // A raw control: destroyed with NO hygiene pass — the lane's
      // no-cleanup contrast.
      target.win.destroy();
      report({ kind: 'target-closed', targetId: command.targetId, hygiene: null });
    }
    targets.delete(command.targetId);
  }

  // The command table — one small handler per op, dispatched by lookup.
  // The mapped type derives every signature from the `HarnessCommand`
  // union itself, so the table's totality is a compile error when
  // broken: a missing op or a handler that takes or returns the wrong
  // shape no longer typechecks.
  const commands: {
    readonly [K in HarnessCommand as K['op']]: (command: K) => Promise<void>;
  } = {
    open,
    load,
    'register-hostile-sw': (command) =>
      executeProbe(command.targetId, REGISTER_HOSTILE_SW_SCRIPT, 'sw-registered'),
    'sw-state': (command) => executeProbe(command.targetId, SW_STATE_SCRIPT, 'sw-state'),
    'fetch-probe': (command) =>
      executeProbe(command.targetId, fetchProbeScript(command.path), 'fetch-probe'),
    'sse-probe': (command) => executeProbe(command.targetId, SSE_PROBE_SCRIPT, 'sse-probe'),
    'canvas-state': (command) =>
      executeProbe(command.targetId, CANVAS_STATE_SCRIPT, 'canvas-state'),
    'hmr-state': (command) => executeProbe(command.targetId, HMR_STATE_SCRIPT, 'hmr-state'),
    'bind-editor': bindEditor,
    'authority-state': authorityState,
    'open-devtools': async (command) => {
      const { win } = requireTarget(command.targetId);
      win.webContents.openDevTools({ mode: 'detach' });
      report({ kind: 'devtools-opened', targetId: command.targetId });
    },
    'close-devtools': async (command) => {
      const { win } = requireTarget(command.targetId);
      win.webContents.closeDevTools();
      report({ kind: 'devtools-closed', targetId: command.targetId });
    },
    'detach-debugger': async (command) => {
      const { win } = requireTarget(command.targetId);
      win.webContents.debugger.detach();
      report({ kind: 'debugger-detach-requested', targetId: command.targetId });
    },
    reactivate,
    'close-target': closeTarget,
    quit: async () => {
      app.exit(0);
    },
  };

  async function handle(command: HarnessCommand): Promise<void> {
    // The one dispatch point: the mapped table's key set is exactly the
    // command union's ops (enforced by the type); the cast is only the
    // correlated-union call TS cannot express for a checked-union key.
    const handler = commands[command.op] as (command: HarnessCommand) => Promise<void>;
    await handler(command);
  }

  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let command: HarnessCommand;
    try {
      command = JSON.parse(trimmed) as HarnessCommand;
    } catch {
      report({ kind: 'protocol-error' });
      return;
    }
    void handle(command).catch((error: unknown) => {
      report({
        kind: 'harness-error',
        op: command.op,
        message: error instanceof Error ? error.message : 'unknown',
      });
    });
  });
  report({ kind: 'ready' });
}

void main().catch((error: unknown) => {
  console.error(
    `astroix-sw-harness: main failed (${error instanceof Error ? error.message : String(error)})`,
  );
  app.exit(1);
});
