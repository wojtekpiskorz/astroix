import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHarnessMain, freePort, type HarnessEvent, HarnessRun, REPO } from './harness-kit.ts';

/**
 * The service-worker bypass real-Electron lane (#247, H5 focused
 * tests): the REAL Electron 44.1.0 binary running this lane's harness
 * main (`apps/desktop/src/service-worker/bypass-harness.ts`, built
 * here with the workspace's own bundler) — the real fresh
 * nonpersistent editing partitions, the real CDP debugger bypass over
 * the real `webContents.debugger`, the real runtime document authority
 * (H4), and the real post-unload partition hygiene — against a REAL
 * Vite dev server origin (the managed origin's serving core) hosting
 * a genuinely hostile root Service Worker. Lane gate, never release
 * evidence (ADR-0008).
 *
 * The fixture project under `e2e/desktop/fixtures/hostile-service-worker/`
 * is this lane's own (the canonical `e2e/fixture` stays plain and
 * untouched — the hostile SW registers through the live Vite origin at
 * runtime, never through anything committed into the managed project).
 *
 * What only this lane can prove, because only the real Chromium
 * network stack has the property: a live, activated, fetch-beaconing
 * root SW on the authoritative origin cannot intercept app, API,
 * canvas, or SSE traffic while the bypass is live (and a raw control
 * window on the same origin IS replaced by it — the non-vacuity
 * proof), the native Vite HMR WebSocket keeps delivering updates under
 * the bypass, DevTools and any debugger detach revoke document
 * authority fail-closed, and the partition hygiene clears SW
 * registrations and Cache Storage only after the old target unloads.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ENTRY = join(REPO, 'apps/desktop/src/service-worker/bypass-harness.ts');
const FIXTURE_ROOT = join(HERE, 'fixtures', 'hostile-service-worker');
const HMR_MODULE = join(FIXTURE_ROOT, 'hmr-mod.js');

/** One recorded request the origin served (or beacons the hostile SW sent). */
interface OriginRecorder {
  readonly requests: string[];
  readonly beacons: string[];
  readonly upgrades: string[];
}

/** The hostile-origin stand-in: a real Vite dev server over this lane's fixture, plus the reserved-namespace routes. */
async function startHostileOrigin(): Promise<{
  origin: string;
  recorder: OriginRecorder;
  server: ViteDevServer;
}> {
  const recorder: OriginRecorder = { requests: [], beacons: [], upgrades: [] };
  const server = await createViteServer({
    root: FIXTURE_ROOT,
    configFile: false,
    logLevel: 'silent',
    clearScreen: false,
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true },
    plugins: [
      {
        name: 'astroix-hostile-origin-recorder',
        configureServer: (vite) => {
          vite.middlewares.use((request, response, next) => {
            const url = request.url ?? '/';
            recorder.requests.push(url);
            if (url.startsWith('/sw-beacon?')) {
              recorder.beacons.push(decodeURIComponent(url.slice('/sw-beacon?event='.length)));
              response.writeHead(204);
              response.end();
              return;
            }
            if (url.startsWith('/__astroix/api/v1/')) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end('{"real":true}');
              return;
            }
            if (url === '/canvas-subresource') {
              response.writeHead(200, { 'content-type': 'text/plain' });
              response.end('REAL-CANVAS-SUBRESOURCE');
              return;
            }
            if (url.split('?')[0] === '/__astroix/events') {
              response.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-store',
                connection: 'keep-alive',
              });
              response.write('data: SERVER-SSE-ONE\n\n');
              setTimeout(() => {
                if (!response.destroyed) response.write('data: SERVER-SSE-TWO\n\n');
              }, 100);
              setTimeout(() => {
                if (!response.destroyed) response.end();
              }, 300);
              return;
            }
            next();
          });
          vite.httpServer?.on('upgrade', (request) => {
            recorder.upgrades.push(request.url ?? '(unknown)');
          });
        },
      },
    ],
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || typeof address !== 'object') throw new Error('no origin address');
  return { origin: `http://127.0.0.1:${address.port}`, recorder, server };
}

/**
 * This lane's run over the shared kit: the `astroix-sw-harness: ` report
 * prefix plus the repeated-probe discipline — every probe waits for ITS
 * OWN response (the next `kind`/`targetId` event, never a stale earlier
 * one) and surfaces a harness error instead of a silent stale read.
 */
class SwHarnessRun extends HarnessRun {
  constructor(bundle: string) {
    super({ bundle, reportPrefix: 'astroix-sw-harness: ' });
  }

  /**
   * Sends one command and waits for ITS OWN event, returning the whole
   * event — for reports whose payload is the event itself, not a probe
   * `result` field (the authority-state snapshot), typed by the caller.
   */
  async probeEvent<T>(
    command: Record<string, unknown>,
    kind: string,
    targetId: string,
    what: string,
  ): Promise<T> {
    const seqFloor = this.events.length;
    this.send(command);
    const event = await this.waitForNext(
      (candidate, seq) =>
        candidate.kind === kind && candidate.targetId === targetId && seq >= seqFloor,
      what,
    );
    return event as T;
  }

  /** Sends one command and waits for ITS OWN response, typed by the caller. */
  async probe<T>(
    command: Record<string, unknown>,
    kind: string,
    targetId: string,
    what: string,
  ): Promise<T> {
    const event = await this.probeEvent<HarnessEvent>(command, kind, targetId, what);
    if (event.error !== undefined) {
      throw new Error(`${what} failed in the harness: ${String(event.error)}`);
    }
    return (event.result ?? {}) as T;
  }
}

interface SwState {
  readonly registration: boolean;
  readonly activeState: string | null;
  readonly controller: boolean;
  readonly caches: readonly string[];
  readonly appMarker: string | null;
  readonly bodyStart: string;
}

interface FetchProbe {
  readonly path: string;
  readonly status?: number;
  readonly body?: string;
  readonly spoofed?: boolean;
  readonly error?: string;
}

interface SseProbe {
  readonly events: readonly string[];
  readonly endedBy: string;
}

interface CanvasState {
  readonly sameOriginDirectDom: boolean;
  readonly canvasMarker: string | null;
  readonly iframeBodyStart: string | null;
  readonly probe: { readonly fetches: Readonly<Record<string, string>> } | null;
}

interface HmrState {
  readonly label: string | null;
  readonly updates: number;
}

interface AuthorityState {
  readonly readiness: { readonly ready: boolean; readonly guardState: string };
  readonly injectable: string | null;
  readonly actions: readonly string[];
}

let origin: Awaited<ReturnType<typeof startHostileOrigin>>;
let run: SwHarnessRun;
let bundlePath: string;
let scratchDir: string;
let hmrModuleOriginal: string;

/** The partition one target-opened event named. */
function partitionOf(targetId: string): string {
  const event = run.events.find(
    (candidate) => candidate.kind === 'target-opened' && candidate.targetId === targetId,
  );
  if (event === undefined) throw new Error(`no target-opened for ${targetId}`);
  return String(event.partition);
}

beforeAll(async () => {
  origin = await startHostileOrigin();
  hmrModuleOriginal = await readFile(HMR_MODULE, 'utf8');
  scratchDir = await mkdtemp(join(tmpdir(), 'astroix-sw-harness-'));
  bundlePath = await buildHarnessMain(HARNESS_ENTRY, scratchDir);
  run = new SwHarnessRun(bundlePath);
  await run.waitFor((event) => event.kind === 'ready', 'the harness ready line');
}, 180_000);

afterAll(async () => {
  await run?.stop();
  await origin?.server.close();
  // The HMR module is restored byte-exact — the lane's live edit is
  // test-time only; the fixture must never land dirty.
  if (hmrModuleOriginal !== undefined) await writeFile(HMR_MODULE, hmrModuleOriginal);
  if (scratchDir !== undefined) await rm(scratchDir, { recursive: true, force: true });
});

describe('the service-worker bypass — real Electron, real Vite origin, real hostile root SW', () => {
  it('activates the bypass before navigation, and a live hostile root SW cannot intercept app, API, canvas, or SSE', async () => {
    // The bypass-guarded editing target: fresh minted partition, CDP
    // bypass active BEFORE the first project request.
    run.send({ op: 'open', targetId: 't1', mode: 'bypassed' });
    const opened = await run.waitFor(
      (event) => event.kind === 'target-opened' && event.targetId === 't1',
      'the bypassed target opening',
    );
    expect(String(opened.mode)).toBe('bypassed');
    expect(String(opened.partition).startsWith('astroix-editing-')).toBe(true);
    expect(String(opened.partition).startsWith('persist:')).toBe(false);
    await run.waitFor(
      (event) => event.kind === 'activation' && event.targetId === 't1' && event.ok === true,
      'the bypass activation',
    );

    run.send({ op: 'load', targetId: 't1', url: `${origin.origin}/` });
    const loaded = await run.waitFor(
      (event) => event.kind === 'loaded' && event.targetId === 't1',
      'the initial document load',
    );
    expect(loaded.outcome).toEqual({ kind: 'loaded' });

    // The hostile SW REALLY registers and activates through the live
    // Vite origin on this partition — and poisons Cache Storage.
    const registered = await run.probe(
      { op: 'register-hostile-sw', targetId: 't1' },
      'sw-registered',
      't1',
      'the hostile SW registration',
    );
    expect(registered).toMatchObject({ active: true, state: 'activated' });
    await expect.poll(() => origin.recorder.beacons).toContain('installed');
    await expect.poll(() => origin.recorder.beacons).toContain('activated');
    const liveState = await run.probe<SwState>(
      { op: 'sw-state', targetId: 't1' },
      'sw-state',
      't1',
      'the live SW state',
    );
    expect(liveState.registration).toBe(true);
    expect(liveState.activeState).toBe('activated');
    expect(liveState.caches).toContain('hostile-cache');

    // The reload under bypass: the document is the REAL app document,
    // never SW-served (a bypassed navigation cannot become controlled).
    run.send({ op: 'load', targetId: 't1', url: `${origin.origin}/?reload=1` });
    await run.waitFor(
      (event) =>
        event.kind === 'loaded' &&
        event.targetId === 't1' &&
        String(event.url).includes('reload=1'),
      'the bypassed reload',
    );
    const reloadedState = await run.probe<SwState>(
      { op: 'sw-state', targetId: 't1' },
      'sw-state',
      't1',
      'the reloaded SW state',
    );
    // The controller FLAG may persist across reloads (a claimed client
    // lineage keeps it) — control is not interception. The load-bearing
    // law is the bytes: the reloaded document is the REAL app document.
    expect(reloadedState.appMarker).toBe('REAL-APP-DOCUMENT');
    expect(reloadedState.bodyStart).not.toContain('SPOOFED-BY-HOSTILE-SW');

    // App, reserved-namespace API, and canvas documents: all real bytes.
    const app = await run.probe<FetchProbe>(
      { op: 'fetch-probe', targetId: 't1', path: '/' },
      'fetch-probe',
      't1',
      'the app document fetch',
    );
    expect(app.spoofed).toBe(false);
    expect(app.body).toContain('REAL-APP-DOCUMENT');
    const api = await run.probe<FetchProbe>(
      { op: 'fetch-probe', targetId: 't1', path: '/__astroix/api/v1/ping' },
      'fetch-probe',
      't1',
      'the API fetch',
    );
    expect(api.spoofed).toBe(false);
    expect(api.body).toBe('{"real":true}');
    const canvasDoc = await run.probe<FetchProbe>(
      { op: 'fetch-probe', targetId: 't1', path: '/canvas.html' },
      'fetch-probe',
      't1',
      'the canvas document fetch',
    );
    expect(canvasDoc.spoofed).toBe(false);
    expect(canvasDoc.body).toContain('REAL-CANVAS-DOCUMENT');

    // The SSE stream: the server's real events, never a spoofed body.
    const sse = await run.probe<SseProbe>(
      { op: 'sse-probe', targetId: 't1' },
      'sse-probe',
      't1',
      'the SSE probe',
    );
    expect(sse.endedBy).toBe('messages');
    expect(sse.events).toEqual(['SERVER-SSE-ONE', 'SERVER-SSE-TWO']);

    // The canvas iframe: same-origin direct DOM intact, its own fetches real.
    let canvas: CanvasState | undefined;
    for (let attempt = 0; attempt < 20 && canvas === undefined; attempt += 1) {
      const state = await run.probe<CanvasState>(
        { op: 'canvas-state', targetId: 't1' },
        'canvas-state',
        't1',
        'the canvas state',
      );
      if (state.probe !== null) canvas = state;
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(canvas).toBeDefined();
    expect(canvas?.sameOriginDirectDom).toBe(true);
    expect(canvas?.canvasMarker).toBe('REAL-CANVAS-DOCUMENT');
    expect(canvas?.probe?.fetches['/__astroix/api/v1/ping']).toBe('{"real":true}');
    expect(canvas?.probe?.fetches['/canvas-subresource']).toBe('REAL-CANVAS-SUBRESOURCE');

    // The live worker saw NONE of it: zero interception beacons.
    expect(origin.recorder.beacons.filter((beacon) => beacon.startsWith('fetch:'))).toEqual([]);

    // Authority exists only after the bypass: bound now, with the
    // ordering evidence in the target's own action log.
    run.send({ op: 'bind-editor', targetId: 't1' });
    const bound = await run.waitFor(
      (event) => event.kind === 'editor-bound' && event.targetId === 't1',
      'the editor bind on the bypassed target',
    );
    expect(String((bound.outcome as { capability: string }).capability).length).toBeGreaterThan(0);
    const authorityState = await run.probeEvent<AuthorityState>(
      { op: 'authority-state', targetId: 't1' },
      'authority-state',
      't1',
      'the authority state',
    );
    expect(authorityState.readiness.ready).toBe(true);
    expect(authorityState.readiness.guardState).toBe('bypassed');
    expect(authorityState.injectable).not.toBe(null);
    expect(authorityState.actions.indexOf('neutral-boot-loaded')).toBe(0);
    expect(authorityState.actions.indexOf('bypass-set')).toBeLessThan(
      authorityState.actions.indexOf('navigation-started'),
    );
    expect(authorityState.actions).not.toContain('navigation-refused');
  }, 120_000);

  it('keeps the native Vite HMR WebSocket functional under the bypass', async () => {
    const before = await run.probe<HmrState>(
      { op: 'hmr-state', targetId: 't1' },
      'hmr-state',
      't1',
      'the pre-edit HMR state',
    );
    expect(before.label).toBe('hmr-v1');
    expect(before.updates).toBe(0);
    // The real WebSocket handshake happened at the network layer (no
    // Service Worker can see it — SW mode none).
    expect(origin.recorder.upgrades.length).toBeGreaterThanOrEqual(1);

    // A REAL file edit through the live Vite watcher: only the native
    // HMR transport can deliver the update.
    await writeFile(HMR_MODULE, hmrModuleOriginal.replace('hmr-v1', 'hmr-v2'));
    let delivered = false;
    for (let attempt = 0; attempt < 40 && !delivered; attempt += 1) {
      const state = await run.probe<HmrState>(
        { op: 'hmr-state', targetId: 't1' },
        'hmr-state',
        't1',
        'the post-edit HMR state',
      );
      if (state.label === 'hmr-v2' && state.updates >= 1) delivered = true;
      else await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(delivered).toBe(true);
    await writeFile(HMR_MODULE, hmrModuleOriginal);
  }, 120_000);

  it('revokes document authority fail-closed on debugger detach and DevTools, and recovers on a reloaded target', async () => {
    const firstBind = run.events.find((event) => event.kind === 'editor-bound');
    if (firstBind === undefined) throw new Error('no editor bind preceded the detach leg');
    const firstCapability = String((firstBind.outcome as { capability: string }).capability);

    // The explicit API detach: the real detach event, the real revocation.
    run.send({ op: 'detach-debugger', targetId: 't1' });
    await run.waitFor(
      (event) =>
        event.kind === 'target-unready' &&
        event.targetId === 't1' &&
        event.failureKind === 'debugger-detached',
      'the API-detach fail-closed event',
    );
    const state = await run.probeEvent<AuthorityState>(
      { op: 'authority-state', targetId: 't1' },
      'authority-state',
      't1',
      'the post-detach authority state',
    );
    expect(state.readiness.ready).toBe(false);
    expect(state.readiness.guardState).toBe('compromised');
    expect(state.injectable).toBe(null);
    expect(state.actions).toContain('authority-revoked');
    run.send({ op: 'bind-editor', targetId: 't1' });
    const refused = await run.waitFor(
      (event) => event.kind === 'editor-bind-refused' && event.targetId === 't1',
      'the post-detach bind refusal',
    );
    expect((refused.outcome as { reason: string }).reason).toBe('bypass-not-active');

    // Recovery round 1: re-activation, a reloaded target, a FRESH bind.
    run.send({ op: 'reactivate', targetId: 't1' });
    await run.waitFor(
      (event) =>
        event.kind === 'activation' &&
        event.targetId === 't1' &&
        event.ok === true &&
        run.events.indexOf(event) > run.events.indexOf(refused),
      'the re-activation',
    );
    run.send({ op: 'load', targetId: 't1', url: `${origin.origin}/?recovered=1` });
    await run.waitFor(
      (event) =>
        event.kind === 'loaded' &&
        event.targetId === 't1' &&
        String(event.url).includes('recovered=1'),
      'the recovered reload',
    );
    run.send({ op: 'bind-editor', targetId: 't1' });
    const rebound = await run.waitFor(
      (event) =>
        event.kind === 'editor-bound' &&
        event.targetId === 't1' &&
        run.events.indexOf(event) > run.events.indexOf(refused),
      'the recovered rebind',
    );
    const secondCapability = String((rebound.outcome as { capability: string }).capability);
    expect(secondCapability).not.toBe(firstCapability);

    // DevTools: the observed Electron 44.1.0 law (this lane's own
    // finding) is that opening DevTools neither detaches the debugger
    // nor blocks it — so the guard watches `devtools-opened` itself:
    // the moment DevTools opens on the authoritative target, it is
    // kicked off, the debugger slot cleaned, and the target compromised
    // (document authority revoked fail-closed).
    run.send({ op: 'open-devtools', targetId: 't1' });
    await run.waitFor(
      (event) =>
        event.kind === 'target-unready' &&
        event.targetId === 't1' &&
        event.failureKind === 'devtools-opened' &&
        run.events.indexOf(event) > run.events.indexOf(rebound),
      'the DevTools fail-closed event',
    );
    const devtoolsState = await run.probeEvent<AuthorityState>(
      { op: 'authority-state', targetId: 't1' },
      'authority-state',
      't1',
      'the post-DevTools authority state',
    );
    expect(devtoolsState.readiness.ready).toBe(false);
    expect(devtoolsState.readiness.guardState).toBe('compromised');
    expect(devtoolsState.injectable).toBe(null);
    expect(devtoolsState.actions).toContain('authority-revoked');
    run.send({ op: 'bind-editor', targetId: 't1' });
    await run.waitFor(
      (event) =>
        event.kind === 'editor-bind-refused' &&
        event.targetId === 't1' &&
        run.events.indexOf(event) > run.events.indexOf(rebound),
      'the bind refusal under DevTools',
    );

    // Recovery round 2: DevTools was kicked off by the host, the slot
    // cleaned — a reloaded target restores the bypass and binds fresh.
    run.send({ op: 'reactivate', targetId: 't1' });
    const reactivationMarker = run.events.length;
    await run.waitFor(
      (event) =>
        event.kind === 'activation' &&
        event.targetId === 't1' &&
        event.ok === true &&
        run.events.indexOf(event) >= reactivationMarker,
      'the post-DevTools re-activation',
    );
    run.send({ op: 'load', targetId: 't1', url: `${origin.origin}/?recovered=2` });
    await run.waitFor(
      (event) =>
        event.kind === 'loaded' &&
        event.targetId === 't1' &&
        String(event.url).includes('recovered=2'),
      'the second recovered reload',
    );
    run.send({ op: 'bind-editor', targetId: 't1' });
    const reboundAgain = await run.waitFor(
      (event) =>
        event.kind === 'editor-bound' &&
        event.targetId === 't1' &&
        run.events.indexOf(event) >= reactivationMarker,
      'the second recovered rebind',
    );
    expect(String((reboundAgain.outcome as { capability: string }).capability)).not.toBe(
      secondCapability,
    );
    // The document stayed real through it all — the SW never took it.
    const finalState = await run.probe<SwState>(
      { op: 'sw-state', targetId: 't1' },
      'sw-state',
      't1',
      'the final SW state',
    );
    expect(finalState.appMarker).toBe('REAL-APP-DOCUMENT');
  }, 120_000);

  it('clears SW state only after unload — and proves the contrast: no cleanup leaves a controlling SW; a fresh partition never sees one', async () => {
    const t1Partition = partitionOf('t1');
    // The SW state is REALLY live on t1's partition right now.
    const beforeClose = await run.probe<SwState>(
      { op: 'sw-state', targetId: 't1' },
      'sw-state',
      't1',
      'the pre-close SW state',
    );
    expect(beforeClose.registration).toBe(true);
    expect(beforeClose.caches).toContain('hostile-cache');

    // Close-and-clean: guard disposed, unload awaited, THEN the clear.
    run.send({ op: 'close-target', targetId: 't1' });
    const closed = await run.waitFor(
      (event) => event.kind === 'target-closed' && event.targetId === 't1',
      'the target close with hygiene',
    );
    expect(closed.hygiene).toEqual({ ok: true, storages: ['serviceworkers', 'cachestorage'] });

    // Reusing the CLEANED partition without protection: nothing left to
    // control it — the post-unload cleanup's real proof.
    run.send({ op: 'open', targetId: 'reuse-clean', mode: 'raw', partition: t1Partition });
    await run.waitFor(
      (event) => event.kind === 'target-opened' && event.targetId === 'reuse-clean',
      'the cleaned-partition reuse window',
    );
    run.send({ op: 'load', targetId: 'reuse-clean', url: `${origin.origin}/` });
    await run.waitFor(
      (event) => event.kind === 'loaded' && event.targetId === 'reuse-clean',
      'the cleaned-partition load',
    );
    const cleaned = await run.probe<SwState>(
      { op: 'sw-state', targetId: 'reuse-clean' },
      'sw-state',
      'reuse-clean',
      'the cleaned-partition SW state',
    );
    expect(cleaned.registration).toBe(false);
    expect(cleaned.controller).toBe(false);
    expect(cleaned.caches).toEqual([]);
    expect(cleaned.appMarker).toBe('REAL-APP-DOCUMENT');

    // The control: an UNPROTECTED window on a fresh control partition —
    // the same origin, the same live hostile SW, no bypass.
    run.send({ op: 'open', targetId: 'ctl', mode: 'raw', partition: 'astroix-sw-control-a' });
    await run.waitFor(
      (event) => event.kind === 'target-opened' && event.targetId === 'ctl',
      'the control window',
    );
    run.send({ op: 'load', targetId: 'ctl', url: `${origin.origin}/` });
    await run.waitFor(
      (event) => event.kind === 'loaded' && event.targetId === 'ctl',
      'the control load',
    );
    const controlRegistration = await run.probe(
      { op: 'register-hostile-sw', targetId: 'ctl' },
      'sw-registered',
      'ctl',
      'the control SW registration',
    );
    expect(controlRegistration).toMatchObject({ active: true });
    // Reload into control: the app document itself is REPLACED by the
    // hostile SW — the exact threat, live, without the bypass.
    run.send({ op: 'load', targetId: 'ctl', url: `${origin.origin}/?controlled=1` });
    await run.waitFor(
      (event) => event.kind === 'loaded' && event.targetId === 'ctl',
      'the controlled reload',
    );
    const controlled = await run.probe<SwState>(
      { op: 'sw-state', targetId: 'ctl' },
      'sw-state',
      'ctl',
      'the controlled SW state',
    );
    expect(controlled.controller).toBe(true);
    expect(controlled.appMarker).toBe(null);
    expect(controlled.bodyStart.startsWith('SPOOFED-BY-HOSTILE-SW')).toBe(true);
    const intercepted = await run.probe<FetchProbe>(
      { op: 'fetch-probe', targetId: 'ctl', path: '/__astroix/api/v1/ping' },
      'fetch-probe',
      'ctl',
      'the intercepted API fetch',
    );
    expect(intercepted.spoofed).toBe(true);
    const spoofedSse = await run.probe<SseProbe>(
      { op: 'sse-probe', targetId: 'ctl' },
      'sse-probe',
      'ctl',
      'the spoofed SSE probe',
    );
    expect(spoofedSse.events).not.toEqual(['SERVER-SSE-ONE', 'SERVER-SSE-TWO']);
    // Non-vacuity at the wire: the worker really intercepted traffic.
    await expect
      .poll(() => origin.recorder.beacons.filter((beacon) => beacon.startsWith('fetch:')))
      .toContain('fetch:/__astroix/api/v1/ping');

    // Destroyed WITHOUT cleanup: the SW SURVIVES the unload (the
    // harness retains the partition session — an app-side reference).
    run.send({ op: 'close-target', targetId: 'ctl' });
    await run.waitFor(
      (event) => event.kind === 'target-closed' && event.targetId === 'ctl',
      'the control destroy (no hygiene)',
    );
    run.send({
      op: 'open',
      targetId: 'reuse-dirty',
      mode: 'raw',
      partition: 'astroix-sw-control-a',
    });
    await run.waitFor(
      (event) => event.kind === 'target-opened' && event.targetId === 'reuse-dirty',
      'the uncleared-partition reuse window',
    );
    run.send({ op: 'load', targetId: 'reuse-dirty', url: `${origin.origin}/` });
    await run.waitFor(
      (event) => event.kind === 'loaded' && event.targetId === 'reuse-dirty',
      'the uncleared-partition load',
    );
    const survived = await run.probe<SwState>(
      { op: 'sw-state', targetId: 'reuse-dirty' },
      'sw-state',
      'reuse-dirty',
      'the uncleared-partition SW state',
    );
    expect(survived.registration).toBe(true);
    expect(survived.controller).toBe(true);
    expect(survived.caches).toContain('hostile-cache');
    expect(survived.bodyStart.startsWith('SPOOFED-BY-HOSTILE-SW')).toBe(true);

    // A FRESH editing target: a never-used partition never sees any of
    // it — fresh storage, bypass before navigation, authority bound.
    run.send({ op: 'open', targetId: 'fresh', mode: 'bypassed' });
    const freshOpened = await run.waitFor(
      (event) => event.kind === 'target-opened' && event.targetId === 'fresh',
      'the fresh bypassed target',
    );
    const freshPartition = String(freshOpened.partition);
    expect(freshPartition).not.toBe(t1Partition);
    expect(freshPartition).not.toBe('astroix-sw-control-a');
    await run.waitFor(
      (event) => event.kind === 'activation' && event.targetId === 'fresh' && event.ok === true,
      'the fresh target activation',
    );
    run.send({ op: 'load', targetId: 'fresh', url: `${origin.origin}/` });
    await run.waitFor(
      (event) => event.kind === 'loaded' && event.targetId === 'fresh',
      'the fresh target load',
    );
    const freshState = await run.probe<SwState>(
      { op: 'sw-state', targetId: 'fresh' },
      'sw-state',
      'fresh',
      'the fresh target SW state',
    );
    expect(freshState.registration).toBe(false);
    expect(freshState.controller).toBe(false);
    expect(freshState.caches).toEqual([]);
    run.send({ op: 'bind-editor', targetId: 'fresh' });
    await run.waitFor(
      (event) => event.kind === 'editor-bound' && event.targetId === 'fresh',
      'the fresh target bind',
    );
  }, 120_000);
});
