import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHarnessMain, HarnessRun, REPO } from './harness-kit.ts';

/**
 * The document-authority real-Electron lane (#246, H4 focused tests):
 * the REAL Electron 44.1.0 binary running this lane's harness main
 * (`apps/desktop/src/document-authority/injection-harness.ts`, built
 * here with the workspace's own bundler) — the real runtime document
 * authority over the real F2/F4 tables, the real
 * `session.defaultSession.webRequest` injection, the real webContents
 * lifecycle events of a H1-hardened window — against a recording
 * loopback server standing in for the origin. Lane gate, never release
 * evidence (ADR-0008).
 *
 * What only this lane can prove, because only the real Chromium network
 * stack has the property: the injected `x-astroix-client` lands AFTER
 * JavaScript request construction (a renderer fetch carrying a forged
 * same-named header leaves with the live capability instead), the
 * capability is renderer-invisible, and a dead or forged value never
 * leaves the host after every invalidation cause.
 */

const HARNESS_ENTRY = join(REPO, 'apps/desktop/src/document-authority/injection-harness.ts');

/** One recorded request: every raw header pair, in arrival order. */
interface RecordedRequest {
  readonly url: string;
  readonly rawHeaders: readonly string[];
}

/** The recording stand-in origin: one route recording everything, `/probe` indexed by label. */
interface RecordingOrigin {
  readonly origin: string;
  requests(): readonly RecordedRequest[];
  byLabel(label: string): RecordedRequest | undefined;
  close(): Promise<void>;
}

async function startRecordingOrigin(): Promise<RecordingOrigin> {
  const recorded: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    recorded.push({ url: request.url ?? '/', rawHeaders: [...request.rawHeaders] });
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>probe</title>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('no origin address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests: () => recorded,
    byLabel: (label) => recorded.find((entry) => entry.url === `/probe?label=${label}`),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(() => resolve());
        server.once('error', reject);
      }),
  };
}

/** The client-capability pairs one recorded request carried, any casing. */
function clientHeaderPairs(
  request: RecordedRequest | undefined,
): { name: string; value: string }[] {
  if (request === undefined) return [];
  const pairs: { name: string; value: string }[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i] ?? '';
    if (name.toLowerCase() === 'x-astroix-client') {
      pairs.push({ name, value: request.rawHeaders[i + 1] ?? '' });
    }
  }
  return pairs;
}

/** True when the forged renderer value appears as ANY header value of the request. */
function carriesForgedValue(request: RecordedRequest | undefined): boolean {
  if (request === undefined) return false;
  return request.rawHeaders.includes('forged-renderer-value');
}

/** One spawned harness run: the line protocol over the real Electron main (the shared kit, this lane's prefix and config argv). */
class DaHarnessRun extends HarnessRun {
  constructor(bundle: string, origin: string) {
    super({ bundle, reportPrefix: 'astroix-da-harness: ', argv: [JSON.stringify({ origin })] });
  }
}

const runs: DaHarnessRun[] = [];
let origin: RecordingOrigin;
let bundlePath: string;
let scratchDir: string;

beforeAll(async () => {
  origin = await startRecordingOrigin();
  scratchDir = await mkdtemp(join(tmpdir(), 'astroix-da-harness-'));
  bundlePath = await buildHarnessMain(HARNESS_ENTRY, scratchDir);
}, 180_000);

afterAll(async () => {
  for (const run of runs.splice(0)) await run.stop();
  await origin.close();
  await rm(scratchDir, { recursive: true, force: true });
});

/** One launched, loaded, editor-bound run — the shared prefix of every leg. */
async function launchBoundRun(): Promise<{ run: HarnessRun; capability: string }> {
  const run = new DaHarnessRun(bundlePath, origin.origin);
  runs.push(run);
  await run.waitFor((event) => event.kind === 'ready', 'the harness ready line');
  run.send({ op: 'load', url: `${origin.origin}/` });
  await run.waitFor((event) => event.kind === 'loaded', 'the initial document load');
  run.send({ op: 'bind-editor' });
  const bound = await run.waitFor(
    (event) => event.kind === 'bound' || event.kind === 'refused',
    'the editor bind',
  );
  if (bound.kind !== 'bound')
    throw new Error(`the editor bind was refused: ${JSON.stringify(bound)}`);
  return { run, capability: String(bound.capability) };
}

describe('the document-authority injection — real Electron, real webRequest, real renderer', () => {
  it('injects the live capability after JavaScript request construction and keeps it renderer-invisible', async () => {
    const { run, capability } = await launchBoundRun();

    // The renderer constructs the request IN JAVASCRIPT with a forged
    // same-named header; what leaves is the live capability — exactly
    // one client header, the forged value nowhere on the wire.
    run.send({ op: 'fetch', label: 'one' });
    await run.waitFor(
      (event) => event.kind === 'fetched' && event.label === 'one',
      'the forged-header fetch',
    );
    const one = clientHeaderPairs(origin.byLabel('one'));
    expect(one).toHaveLength(1);
    expect(one[0]?.value).toBe(capability);
    expect(origin.byLabel('one')?.rawHeaders.includes('forged-renderer-value')).toBe(false);

    // Renderer-visible-secret: the capability is a header main injects —
    // never a cookie the document could read, never any other surface.
    run.send({ op: 'cookie-surface' });
    const cookieSurface = await run.waitFor(
      (event) => event.kind === 'cookie-surface',
      'the document.cookie observation',
    );
    expect(String(cookieSurface.value)).not.toContain(capability);
    for (const request of origin.requests()) {
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const name = request.rawHeaders[i] ?? '';
        if (name.toLowerCase() === 'cookie') {
          expect(request.rawHeaders[i + 1] ?? '').not.toContain(capability);
        }
      }
    }

    // A real top-level navigation kills the binding: no header is
    // injected for the new document, and the renderer's forged value is
    // deleted outright — it never leaves the host.
    run.send({ op: 'load', url: `${origin.origin}/?page=2` });
    await run.waitFor(
      (event) => event.kind === 'loaded' && String(event.url).includes('page=2'),
      'the second document load',
    );
    run.send({ op: 'state' });
    await run.waitFor(
      (event) => event.kind === 'state' && event.injectable === null,
      'the post-navigation dead binding',
    );
    run.send({ op: 'fetch', label: 'two' });
    await run.waitFor(
      (event) => event.kind === 'fetched' && event.label === 'two',
      'the post-navigation fetch',
    );
    expect(clientHeaderPairs(origin.byLabel('two'))).toHaveLength(0);
    expect(carriesForgedValue(origin.byLabel('two'))).toBe(false);

    // The new document binds FRESH authority — a new capability, not a
    // reuse of the navigation-1 value.
    run.send({ op: 'bind-editor' });
    const rebound = await run.waitFor(
      (event) => event.kind === 'bound' && Number(event.navigationId) === 2,
      'the rebind at the new document',
    );
    expect(String(rebound.capability)).not.toBe(capability);
    run.send({ op: 'fetch', label: 'three' });
    await run.waitFor(
      (event) => event.kind === 'fetched' && event.label === 'three',
      'the rebound fetch',
    );
    expect(clientHeaderPairs(origin.byLabel('three'))[0]?.value).toBe(String(rebound.capability));
  }, 120_000);

  it('invalidates the injected authority on renderer crash, session replacement, revocation, and target destruction', async () => {
    const { run, capability } = await launchBoundRun();

    run.send({ op: 'fetch', label: 'a' });
    await run.waitFor(
      (event) => event.kind === 'fetched' && event.label === 'a',
      'the pre-crash fetch',
    );
    expect(clientHeaderPairs(origin.byLabel('a'))[0]?.value).toBe(capability);

    // A REAL renderer crash: the wiring's own render-process-gone
    // observation drives the authority — the injected header dies with
    // the renderer.
    run.send({ op: 'crash' });
    await run.waitFor(
      (event) => event.kind === 'state' && event.injectable === null,
      'the post-crash dead binding',
    );

    // The reloaded document (a fresh renderer) binds fresh authority and
    // injects it again — the crash killed the binding, not the seam.
    run.send({ op: 'load', url: `${origin.origin}/` });
    await run.waitFor(
      (event) => event.kind === 'loaded' && Number(event.navigationId) === 2,
      'the post-crash reload',
    );
    run.send({ op: 'bind-editor' });
    const rebound = await run.waitFor(
      (event) => event.kind === 'bound' && Number(event.navigationId) === 2,
      'the post-crash rebind',
    );
    run.send({ op: 'fetch', label: 'b' });
    await run.waitFor(
      (event) => event.kind === 'fetched' && event.label === 'b',
      'the post-crash fetch',
    );
    expect(clientHeaderPairs(origin.byLabel('b'))[0]?.value).toBe(String(rebound.capability));

    // Session replacement: the returning document's binding dies before
    // further control work, and a forged value never fills the gap.
    run.send({ op: 'invalidate', cause: 'session-replaced' });
    await run.waitFor(
      (event) => event.kind === 'state' && event.injectable === null,
      'the session-replaced dead binding',
    );
    run.send({ op: 'fetch', label: 'c' });
    await run.waitFor(
      (event) => event.kind === 'fetched' && event.label === 'c',
      'the session-replaced fetch',
    );
    expect(clientHeaderPairs(origin.byLabel('c'))).toHaveLength(0);
    expect(carriesForgedValue(origin.byLabel('c'))).toBe(false);

    // Revocation: same law, per-capability.
    run.send({ op: 'bind-editor' });
    await run.waitFor(
      (event) => event.kind === 'bound' && Number(event.navigationId) === 2,
      'the rebind after replacement',
    );
    run.send({ op: 'invalidate', cause: 'revoke' });
    await run.waitFor(
      (event) => event.kind === 'state' && event.injectable === null,
      'the revoked dead binding',
    );
    run.send({ op: 'fetch', label: 'd' });
    await run.waitFor(
      (event) => event.kind === 'fetched' && event.label === 'd',
      'the revoked fetch',
    );
    expect(clientHeaderPairs(origin.byLabel('d'))).toHaveLength(0);
    expect(carriesForgedValue(origin.byLabel('d'))).toBe(false);

    // Target destruction: the destroyed webContents' binding dies with
    // it — the port's own truth, observed after the real event.
    run.send({ op: 'bind-editor' });
    await run.waitFor(
      (event) => event.kind === 'bound' && Number(event.navigationId) === 2,
      'the rebind before destruction',
    );
    run.send({ op: 'destroy-target' });
    await run.waitFor(
      (event) => event.kind === 'state' && event.injectable === null,
      'the post-destruction dead binding',
    );
  }, 120_000);
});
