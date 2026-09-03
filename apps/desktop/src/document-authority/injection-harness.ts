import { createInterface } from 'node:readline';
import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { createClientBindings } from '@wojciechpiskorz/astroix-runtime/api/http';
import {
  createDocumentAuthority,
  type DocumentAuthority,
} from '@wojciechpiskorz/astroix-runtime/client-authority';
import { createSessionClients } from '@wojciechpiskorz/astroix-runtime/session-supervisor/clients';
import { app, BrowserWindow, session } from 'electron';
import { observeDocumentTarget } from '../main/document-bindings.ts';
import { WINDOW_SECURITY_PREFERENCES } from '../main/security-policy.ts';
import { installClientCapabilityInjection } from './web-request-injection.ts';

/**
 * The document-authority real-Electron harness (#246, H4 focused lane):
 * a TEST main-process entry — never the product composition, never
 * release evidence (ADR-0008) — that composes the REAL surfaces this
 * lane owns: the runtime document authority over the real F2/F4 tables,
 * the webRequest injection over the real `session.defaultSession`, and
 * the document-binding lifecycle over the real webContents events of a
 * H1-hardened window. The product main's own wiring of these seams
 * lands with the desktop composition lane (index.ts is H1's file, not
 * this lane's); what this harness proves is the Electron laws
 * themselves, against real Chromium network stack behavior:
 *
 * - injection lands AFTER JavaScript request construction (a renderer
 *   fetch carrying a forged `X-ASTROIX-CLIENT` leaves with the live
 *   capability instead);
 * - the capability is renderer-invisible (it is a header main injects,
 *   never a cookie, never a preload value);
 * - navigation, renderer crash, session replacement, revocation, and
 *   target destruction each kill the injected authority — and a dead or
 *   forged header value never leaves the host at all.
 *
 * Protocol: one JSON object per stdin line (see the command table in
 * `handle`), one `astroix-da-harness: <json>` line per response on
 * stdout. The harness prints the live capability in its reports — TEST
 * evidence for the spec's equality assertions, not product logging
 * (the product surfaces never log a capability; F2's law).
 */

interface HarnessConfig {
  readonly origin: string;
}

const SESSION: SessionRef = { runtimeEpoch: 'harness-epoch', generation: 1 };
const PROJECT_KEY = 'abcdefghijklmnopqrstuvwxyz';

function readConfig(argv: readonly string[]): HarnessConfig {
  const parsed: unknown = JSON.parse(argv[2] ?? '{}');
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('astroix-da-harness: the config argument is not a JSON object');
  }
  const origin = (parsed as Record<string, unknown>).origin;
  if (typeof origin !== 'string' || origin.length === 0) {
    throw new Error('astroix-da-harness: the config argument misses its origin');
  }
  return { origin };
}

function report(event: Record<string, unknown>): void {
  console.log(`astroix-da-harness: ${JSON.stringify(event)}`);
}

/** One command off the spec's stdin. */
type HarnessCommand =
  | { readonly op: 'load'; readonly url: string }
  | { readonly op: 'bind-editor' }
  | { readonly op: 'bind-diagnostic' }
  | { readonly op: 'fetch'; readonly label: string }
  | { readonly op: 'cookie-surface' }
  | { readonly op: 'crash' }
  | { readonly op: 'invalidate'; readonly cause: 'session-replaced' | 'revoke' }
  | { readonly op: 'state' }
  | { readonly op: 'destroy-target' }
  | { readonly op: 'quit' };

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

  // — the hardened window and its real lifecycle wiring —
  const win = new BrowserWindow({
    title: 'Astroix document-authority harness',
    width: 480,
    height: 320,
    show: false,
    webPreferences: { ...WINDOW_SECURITY_PREFERENCES },
  });
  const wc = win.webContents;
  // Snapshot the integer identity up front — reading it off a destroyed
  // webContents throws, and the post-destruction state view still needs it.
  const webContentsId = wc.id;
  // The real lifecycle wiring over the real webContents events — the
  // harness lives and dies with its one window, so the unbinds are
  // unused (the seam's contract keeps them).
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
      wc.on('destroyed', () => handler());
      return () => {};
    },
  });

  const stateView = (): Record<string, unknown> => ({
    kind: 'state',
    injectable: authority.injectableCapability(webContentsId),
    navigationId: navigation.currentNavigationId(),
  });

  /** One bind attempt reported in the protocol's shape (editor or diagnostic). */
  function reportBind(
    role: 'editor' | 'diagnostic',
    bound:
      | { readonly kind: 'bound'; readonly grant: { readonly capability: string } }
      | { readonly kind: 'refused'; readonly reason: string },
  ): void {
    report(
      bound.kind === 'bound'
        ? {
            kind: 'bound',
            role,
            capability: bound.grant.capability,
            navigationId: navigation.currentNavigationId(),
          }
        : { kind: 'refused', reason: bound.reason },
    );
  }

  async function loadDocument(command: Extract<HarnessCommand, { op: 'load' }>): Promise<void> {
    await wc.loadURL(command.url);
    report({
      kind: 'loaded',
      url: wc.getURL(),
      navigationId: navigation.currentNavigationId(),
    });
  }

  async function bindEditor(): Promise<void> {
    authority.declareAuthoritativeTarget(webContentsId);
    reportBind(
      'editor',
      authority.bindEditor({
        document: { webContentsId, navigationId: navigation.currentNavigationId() },
        sessionRef: SESSION,
        projectKey: PROJECT_KEY,
      }),
    );
  }

  async function bindDiagnostic(): Promise<void> {
    reportBind(
      'diagnostic',
      authority.bindDiagnostic({
        document: { webContentsId, navigationId: navigation.currentNavigationId() },
        sessionRef: SESSION,
        projectKey: PROJECT_KEY,
      }),
    );
  }

  async function forgedFetch(command: Extract<HarnessCommand, { op: 'fetch' }>): Promise<void> {
    // The renderer constructs the request IN JAVASCRIPT with a forged
    // same-named header — what leaves is the injection's decision.
    const script = `fetch(${JSON.stringify(`${config.origin}/probe?label=${command.label}`)}, {
      cache: 'no-store',
      headers: { 'X-ASTROIX-CLIENT': 'forged-renderer-value' },
    }).then((response) => response.text().then(() => 'status:' + response.status))`;
    try {
      const outcome = await wc.executeJavaScript(script);
      report({ kind: 'fetched', label: command.label, outcome });
    } catch (error) {
      report({
        kind: 'fetched',
        label: command.label,
        outcome: `error:${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async function cookieSurface(): Promise<void> {
    const cookie = await wc.executeJavaScript('document.cookie');
    report({ kind: 'cookie-surface', value: cookie });
  }

  async function crashRenderer(): Promise<void> {
    // A REAL renderer crash (`forcefullyCrashRenderer` is Electron 44's
    // renderer-crash API; `WebContents.crash` is gone): the wiring's own
    // render-process-gone observation drives the authority, so report
    // after it fires.
    const gone = new Promise<void>((resolve) => {
      wc.once('render-process-gone', () => resolve());
    });
    wc.forcefullyCrashRenderer();
    await gone;
    report(stateView());
  }

  async function invalidate(command: Extract<HarnessCommand, { op: 'invalidate' }>): Promise<void> {
    if (command.cause === 'session-replaced') {
      authority.sessionReplaced(SESSION);
    } else {
      const injectable = authority.injectableCapability(webContentsId);
      if (injectable !== null) authority.revoke(injectable);
    }
    report(stateView());
  }

  async function destroyTarget(): Promise<void> {
    const destroyed = new Promise<void>((resolve) => {
      win.once('closed', () => resolve());
    });
    win.destroy();
    await destroyed;
    report(stateView());
  }

  // The command table — one small handler per op, dispatched by lookup.
  const commands: {
    readonly load: typeof loadDocument;
    readonly 'bind-editor': typeof bindEditor;
    readonly 'bind-diagnostic': typeof bindDiagnostic;
    readonly fetch: typeof forgedFetch;
    readonly 'cookie-surface': typeof cookieSurface;
    readonly crash: typeof crashRenderer;
    readonly invalidate: typeof invalidate;
    readonly state: () => Promise<void>;
    readonly 'destroy-target': typeof destroyTarget;
    readonly quit: () => Promise<void>;
  } = {
    load: loadDocument,
    'bind-editor': bindEditor,
    'bind-diagnostic': bindDiagnostic,
    fetch: forgedFetch,
    'cookie-surface': cookieSurface,
    crash: crashRenderer,
    invalidate,
    state: async () => {
      report(stateView());
    },
    'destroy-target': destroyTarget,
    quit: async () => {
      app.exit(0);
    },
  };

  async function handle(command: HarnessCommand): Promise<void> {
    // The one dispatch point: the table's key set is exactly the
    // command union's ops, so every member is total by construction.
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
        message: error instanceof Error ? error.message : 'unknown',
      });
    });
  });
  report({ kind: 'ready', webContentsId: webContentsId, origin: config.origin });
}

void main().catch((error: unknown) => {
  console.error(
    `astroix-da-harness: main failed (${error instanceof Error ? error.message : String(error)})`,
  );
  app.exit(1);
});
