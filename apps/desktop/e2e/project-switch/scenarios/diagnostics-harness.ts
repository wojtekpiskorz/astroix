import { createInterface } from 'node:readline';
import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { createClientBindings } from '@wojciechpiskorz/astroix-runtime/api/http';
import {
  createDocumentAuthority,
  type DocumentAuthority,
} from '@wojciechpiskorz/astroix-runtime/client-authority';
import { createSessionClients } from '@wojciechpiskorz/astroix-runtime/session-supervisor/clients';
import { app, BrowserWindow, session } from 'electron';
import { installClientCapabilityInjection } from '../../../src/document-authority/web-request-injection.ts';
import { observeDocumentTarget } from '../../../src/main/document-bindings.ts';
import { WINDOW_SECURITY_PREFERENCES } from '../../../src/main/security-policy.ts';

/**
 * The K3 diagnostics real-Electron harness (#256's desktop leg; a TEST
 * main, never the product composition — ADR-0008's lane-gate law, the
 * H4 injection harness's idiom): the REAL document authority over the
 * real F2/F4 tables, the REAL `session.defaultSession.webRequest`
 * client-capability injection, and the REAL webContents lifecycle
 * events of H1-hardened windows — MULTI-WINDOW, the surface the
 * diagnostic-role laws need: one authoritative editor window plus
 * diagnostic windows, each bound and injected with its own separately
 * minted capability, refused past the settled caps, killed together
 * at session replacement, and rebound fresh afterwards.
 *
 * What only this lane can prove, because only the real Chromium
 * network stack has the property: every role's document injects
 * exactly its own live capability after JavaScript request
 * construction, a revoked or replaced capability never leaves any
 * host again (the CDP-detach revocation face — edits disabled
 * fail-closed, never silently degraded), and the rebinding after a
 * switch or a detach is always a FRESH mint, never a revival.
 *
 * Protocol: one JSON config on argv[2]; one
 * `astroix-k3-harness: <json>` line per report on stdout; one JSON
 * command per stdin line (see the command table in `handle`).
 */

interface HarnessConfig {
  readonly origin: string;
}

const PROJECT_KEY = 'abcdefghijklmnopqrstuvwxyz';

function readConfig(argv: readonly string[]): HarnessConfig {
  const parsed = JSON.parse(argv[2] ?? '{}');
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('astroix-k3-harness: the config argument is not a JSON object');
  }
  const origin = (parsed as Record<string, unknown>).origin;
  if (typeof origin !== 'string' || origin.length === 0) {
    throw new Error('astroix-k3-harness: the config argument misses its origin');
  }
  return { origin };
}

function report(event: Record<string, unknown>): void {
  console.log(`astroix-k3-harness: ${JSON.stringify(event)}`);
}

/** One command off the spec's stdin. */
type HarnessCommand =
  | { readonly op: 'open'; readonly id: string }
  | { readonly op: 'load'; readonly id: string; readonly url: string }
  | { readonly op: 'bind-editor'; readonly id: string }
  | { readonly op: 'bind-diagnostic'; readonly id: string }
  | { readonly op: 'fetch'; readonly id: string; readonly label: string; readonly forge?: string }
  | { readonly op: 'state'; readonly id: string }
  | { readonly op: 'counts' }
  | { readonly op: 'set-session'; readonly epoch: string; readonly generation: number }
  | { readonly op: 'session-replaced'; readonly epoch: string; readonly generation: number }
  | { readonly op: 'revoke'; readonly id: string }
  | { readonly op: 'crash'; readonly id: string }
  | { readonly op: 'destroy'; readonly id: string }
  | { readonly op: 'quit' };

/** One live window with its lifecycle observation. */
interface LiveWindow {
  readonly id: string;
  readonly win: BrowserWindow;
  readonly webContentsId: number;
  readonly navigation: ReturnType<typeof observeDocumentTarget>;
}

async function main(): Promise<void> {
  const config = readConfig(process.argv);
  await app.whenReady();

  // — the real runtime authority: F2's HTTP table, F4's registry, the join —
  const httpBindings = createClientBindings();
  const clients = createSessionClients();
  const authority: DocumentAuthority = createDocumentAuthority({ httpBindings, clients });

  // — the injection over the REAL session request pipeline —
  installClientCapabilityInjection({
    webRequest: session.defaultSession.webRequest,
    ownedOrigins: [config.origin],
    authority,
  });

  const windows = new Map<string, LiveWindow>();
  let currentSession: SessionRef = { runtimeEpoch: 'k3-epoch', generation: 1 };

  function liveOf(id: string): LiveWindow {
    const live = windows.get(id);
    if (live === undefined) throw new Error(`no window named ${id}`);
    return live;
  }

  function stateView(id: string): Record<string, unknown> {
    const live = liveOf(id);
    return {
      kind: 'state',
      id,
      injectable: authority.injectableCapability(live.webContentsId),
      navigationId: live.navigation.currentNavigationId(),
    };
  }

  /** One bind attempt reported in the protocol's shape (editor or diagnostic). */
  function reportBind(
    id: string,
    role: 'editor' | 'diagnostic',
    bound:
      | { readonly kind: 'bound'; readonly grant: { readonly capability: string } }
      | { readonly kind: 'refused'; readonly reason: string },
  ): void {
    const live = liveOf(id);
    report(
      bound.kind === 'bound'
        ? {
            kind: 'bound',
            id,
            role,
            capability: bound.grant.capability,
            session: currentSession,
            navigationId: live.navigation.currentNavigationId(),
          }
        : { kind: 'refused', id, role, reason: bound.reason },
    );
  }

  async function openWindow(command: Extract<HarnessCommand, { op: 'open' }>): Promise<void> {
    const win = new BrowserWindow({
      title: `Astroix K3 harness — ${command.id}`,
      width: 480,
      height: 320,
      show: false,
      webPreferences: { ...WINDOW_SECURITY_PREFERENCES },
    });
    const wc = win.webContents;
    const webContentsId = wc.id;
    const navigation = observeDocumentTarget(authority, {
      webContentsId,
      onDidNavigate: (handler) => {
        wc.on('did-navigate', () => handler());
        return () => {};
      },
      onRenderProcessGone: (handler) => {
        wc.on('render-process-gone', () => handler());
        return () => {};
      },
      onDestroyed: (handler) => {
        win.on('closed', () => handler());
        return () => {};
      },
    });
    windows.set(command.id, { id: command.id, win, webContentsId, navigation });
    await wc.loadURL(`${config.origin}/?window=${encodeURIComponent(command.id)}`);
    report({
      kind: 'window-opened',
      id: command.id,
      webContentsId,
      navigationId: navigation.currentNavigationId(),
    });
  }

  async function loadUrl(command: Extract<HarnessCommand, { op: 'load' }>): Promise<void> {
    const live = liveOf(command.id);
    await live.win.webContents.loadURL(command.url);
    report({
      kind: 'loaded',
      id: command.id,
      navigationId: live.navigation.currentNavigationId(),
    });
  }

  async function bindEditor(
    command: Extract<HarnessCommand, { op: 'bind-editor' }>,
  ): Promise<void> {
    const live = liveOf(command.id);
    authority.declareAuthoritativeTarget(live.webContentsId);
    reportBind(
      command.id,
      'editor',
      authority.bindEditor({
        document: {
          webContentsId: live.webContentsId,
          navigationId: live.navigation.currentNavigationId(),
        },
        sessionRef: currentSession,
        projectKey: PROJECT_KEY,
      }),
    );
  }

  async function bindDiagnostic(
    command: Extract<HarnessCommand, { op: 'bind-diagnostic' }>,
  ): Promise<void> {
    const live = liveOf(command.id);
    reportBind(
      command.id,
      'diagnostic',
      authority.bindDiagnostic({
        document: {
          webContentsId: live.webContentsId,
          navigationId: live.navigation.currentNavigationId(),
        },
        sessionRef: currentSession,
        projectKey: PROJECT_KEY,
      }),
    );
  }

  async function forgedFetch(command: Extract<HarnessCommand, { op: 'fetch' }>): Promise<void> {
    const live = liveOf(command.id);
    // The renderer constructs the request IN JAVASCRIPT with a forged
    // same-named header — what leaves is the injection's decision.
    const script = `fetch(${JSON.stringify(`${config.origin}/probe?label=${command.label}`)}, {
      cache: 'no-store',
      headers: { 'X-ASTROIX-CLIENT': ${JSON.stringify(command.forge ?? 'forged-renderer-value')} },
    }).then((response) => response.text().then(() => 'status:' + response.status))`;
    try {
      const outcome = await live.win.webContents.executeJavaScript(script);
      report({ kind: 'fetched', id: command.id, label: command.label, outcome });
    } catch (error) {
      report({
        kind: 'fetched',
        id: command.id,
        label: command.label,
        outcome: `error:${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async function crashRenderer(command: Extract<HarnessCommand, { op: 'crash' }>): Promise<void> {
    const live = liveOf(command.id);
    const gone = new Promise<void>((resolve) => {
      live.win.webContents.once('render-process-gone', () => resolve());
    });
    live.win.webContents.forcefullyCrashRenderer();
    await gone;
    report(stateView(command.id));
  }

  async function destroyWindow(command: Extract<HarnessCommand, { op: 'destroy' }>): Promise<void> {
    const live = liveOf(command.id);
    const closed = new Promise<void>((resolve) => {
      live.win.once('closed', () => resolve());
    });
    live.win.destroy();
    await closed;
    report(stateView(command.id));
  }

  // The command table — one small handler per op, dispatched by lookup.
  const commands: {
    readonly open: typeof openWindow;
    readonly load: typeof loadUrl;
    readonly 'bind-editor': typeof bindEditor;
    readonly 'bind-diagnostic': typeof bindDiagnostic;
    readonly fetch: typeof forgedFetch;
    readonly state: (command: Extract<HarnessCommand, { op: 'state' }>) => Promise<void>;
    readonly counts: () => Promise<void>;
    readonly 'set-session': (command: Extract<HarnessCommand, { op: 'set-session' }>) => void;
    readonly 'session-replaced': (
      command: Extract<HarnessCommand, { op: 'session-replaced' }>,
    ) => void;
    readonly revoke: (command: Extract<HarnessCommand, { op: 'revoke' }>) => void;
    readonly crash: typeof crashRenderer;
    readonly destroy: typeof destroyWindow;
    readonly quit: () => Promise<void>;
  } = {
    open: openWindow,
    load: loadUrl,
    'bind-editor': bindEditor,
    'bind-diagnostic': bindDiagnostic,
    fetch: forgedFetch,
    state: async (command) => {
      report(stateView(command.id));
    },
    counts: async () => {
      const grants = authority.grants();
      const counts = { editor: 0, diagnostic: 0 };
      for (const grant of grants) counts[grant.role] += 1;
      report({ kind: 'counts', counts, live: grants.length });
    },
    'set-session': (command) => {
      currentSession = { runtimeEpoch: command.epoch, generation: command.generation };
      report({ kind: 'session-set', session: currentSession });
    },
    'session-replaced': (command) => {
      authority.sessionReplaced({ runtimeEpoch: command.epoch, generation: command.generation });
      report({ kind: 'replaced', epoch: command.epoch, generation: command.generation });
    },
    revoke: (command) => {
      const injectable = authority.injectableCapability(liveOf(command.id).webContentsId);
      if (injectable !== null) authority.revoke(injectable);
      report(stateView(command.id));
    },
    crash: crashRenderer,
    destroy: destroyWindow,
    quit: async () => {
      app.exit(0);
    },
  };

  async function handle(command: HarnessCommand): Promise<void> {
    // The one dispatch point: the table's key set is exactly the
    // command union's ops, so every member is total by construction.
    const handler = commands[command.op] as (command: HarnessCommand) => Promise<void> | void;
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
        message: error instanceof Error ? error.message : 'unknown',
      });
    });
  });
  report({ kind: 'ready', origin: config.origin });
}

// The Electron-main invocation law every desktop main follows (never
// top-level await — an ESM entry with TLA deadlocks Electron's ready
// wiring): fire main, surface a failure as the harness's own report.
void main().catch((error: unknown) => {
  console.error(
    `astroix-k3-harness: main failed (${error instanceof Error ? error.message : String(error)})`,
  );
  app.exit(1);
});
