import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHarnessMain, HarnessRun, REPO } from '../../../../e2e/desktop/harness-kit.ts';

/**
 * The K3 editor-versus-diagnostics real-Electron lane (#256's desktop
 * leg): the REAL Electron 44.1.0 binary running this lane's scenario
 * harness main (`./scenarios/diagnostics-harness.ts`, built with the
 * workspace's own bundler) — the real runtime document authority over
 * the real F2/F4 tables, the real `webRequest` client-capability
 * injection, and the real webContents lifecycle of H1-hardened
 * windows — MULTI-WINDOW: the editor-versus-diagnostic capability
 * injection and rebinding the ticket's focused tests name. Lane gate,
 * never release evidence (ADR-0008).
 *
 * What this lane proves (K3's desktop ACs):
 * - the settled role limits RETAIN through a switch: one editor and
 *   up to three diagnostics bind with separately minted capabilities,
 *   the second editor and fourth diagnostic are refused, and the caps
 *   hold again at the successor session after a session replacement
 *   killed every old binding together;
 * - every role's document injects exactly its OWN live capability
 *   after JavaScript request construction — a dead (replaced or
 *   revoked) capability never leaves the host again, forged renderer
 *   values never fill the gap: edits are DISABLED fail-closed, never
 *   silently degraded;
 * - the rebinding after a replacement, a revoke (the CDP
 *   debugger-detach cause), a navigation, or a crash is always a
 *   FRESH mint — never a revival of a dead capability.
 *
 * The diagnostic role's WIRE refusal (a diagnostic capability cannot
 * drive `apply-edit` — the command-route matrix) is pinned end-to-end
 * through the real dispatch by the focused unit lane
 * (`packages/runtime/test/http-api/api-dispatch.test.ts`'s
 * "enforces the role matrix end to end"); this lane proves the
 * Electron document faces around that law. Disclosed in the lane's
 * PR.
 */

const HARNESS_ENTRY = join(
  REPO,
  'apps',
  'desktop',
  'e2e',
  'project-switch',
  'scenarios',
  'diagnostics-harness.ts',
);

/** One recorded request: every raw header pair, in arrival order. */
interface RecordedRequest {
  readonly url: string;
  readonly rawHeaders: readonly string[];
}

/** The recording stand-in origin: one route recording everything, `/probe` indexed by label. */
interface RecordingOrigin {
  readonly origin: string;
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

/** One bound report off the line protocol. */
interface BoundReport {
  readonly kind: 'bound';
  readonly id: string;
  readonly role: string;
  readonly capability: string;
}

/** One refused report off the line protocol. */
interface RefusedReport {
  readonly kind: 'refused';
  readonly id: string;
  readonly role: string;
  readonly reason: string;
}

/** This lane's run over the shared kit: the harness prefix plus its config argv. */
class K3HarnessRun extends HarnessRun {
  constructor(bundle: string, origin: string) {
    super({ bundle, reportPrefix: 'astroix-k3-harness: ', argv: [JSON.stringify({ origin })] });
  }
}

const runs: K3HarnessRun[] = [];
let origin: RecordingOrigin;
let bundlePath: string;
let scratchDir: string;

beforeAll(async () => {
  origin = await startRecordingOrigin();
  scratchDir = await mkdtemp(join(tmpdir(), 'astroix-k3-harness-'));
  bundlePath = await buildHarnessMain(HARNESS_ENTRY, scratchDir);
}, 180_000);

afterAll(async () => {
  for (const run of runs.splice(0)) await run.stop();
  await origin.close();
  await rm(scratchDir, { recursive: true, force: true });
});

/** One launched run with the six windows the legs need, opened and loaded. */
async function launchWindowedRun(): Promise<K3HarnessRun> {
  const run = new K3HarnessRun(bundlePath, origin.origin);
  runs.push(run);
  await run.waitFor((event) => event.kind === 'ready', 'the harness ready line');
  for (const id of ['editor', 'd1', 'd2', 'd3', 'd4', 'spare']) {
    run.send({ op: 'open', id });
    await run.waitFor(
      (event) => event.kind === 'window-opened' && event.id === id,
      `the ${id} window opening`,
    );
  }
  return run;
}

/** One bind driven to its report — the typed union of the protocol's two answers. */
async function bind(
  run: K3HarnessRun,
  op: 'bind-editor' | 'bind-diagnostic',
  id: string,
): Promise<BoundReport | RefusedReport> {
  const seqFloor = run.events.length;
  run.send({ op, id });
  const event = await run.waitForNext(
    (candidate, seq) =>
      (candidate.kind === 'bound' || candidate.kind === 'refused') &&
      candidate.id === id &&
      seq >= seqFloor,
    `the ${op} of ${id}`,
  );
  return event as unknown as BoundReport | RefusedReport;
}

/**
 * One bind report asserted into its bound shape — the narrowing every
 * bind site reads (the refusal's full report — role and reason — is the
 * failure's print, not just the kind).
 */
function expectBound(report: BoundReport | RefusedReport, id: string): BoundReport {
  expect(report, `the ${id} bind`).toMatchObject({ kind: 'bound' });
  if (report.kind !== 'bound') throw new Error(`the ${id} bind did not land`);
  return report;
}

/** One renderer fetch driven to its report. */
async function probe(run: K3HarnessRun, id: string, label: string, forge?: string): Promise<void> {
  run.send({ op: 'fetch', id, label, ...(forge === undefined ? {} : { forge }) });
  await run.waitFor(
    (event) => event.kind === 'fetched' && event.id === id && event.label === label,
    `the ${label} fetch from ${id}`,
  );
}

/** One window's injected capability, off its state report. */
async function injected(run: K3HarnessRun, id: string): Promise<string | null> {
  const seqFloor = run.events.length;
  run.send({ op: 'state', id });
  const event = await run.waitForNext(
    (candidate, seq) => candidate.kind === 'state' && candidate.id === id && seq >= seqFloor,
    `the ${id} state`,
  );
  const injectable = event.injectable;
  return typeof injectable === 'string' ? injectable : null;
}

describe('the editor-versus-diagnostics document authority — real Electron, real injection, real roles', () => {
  it('retains the settled role limits through a session switch — one editor, three diagnostics, fresh rebinding', async () => {
    const run = await launchWindowedRun();

    // the editor binds; the diagnostics bind with SEPARATELY minted
    // capabilities of their own.
    const editor = expectBound(await bind(run, 'bind-editor', 'editor'), 'editor');
    const d1 = expectBound(await bind(run, 'bind-diagnostic', 'd1'), 'd1');
    const d2 = expectBound(await bind(run, 'bind-diagnostic', 'd2'), 'd2');
    const d3 = expectBound(await bind(run, 'bind-diagnostic', 'd3'), 'd3');
    const capabilities = new Set([editor.capability, d1.capability, d2.capability, d3.capability]);
    expect(capabilities.size).toBe(4);

    // the caps refuse: the FOURTH diagnostic, the SECOND editor, and a
    // second grant at the editor's own document.
    const d4 = await bind(run, 'bind-diagnostic', 'd4');
    expect(d4).toMatchObject({ kind: 'refused', role: 'diagnostic', reason: 'diagnostics-full' });
    const again = await bind(run, 'bind-diagnostic', 'editor');
    expect(again).toMatchObject({ kind: 'refused', reason: 'document-already-bound' });
    const spare = await bind(run, 'bind-editor', 'spare');
    expect(spare).toMatchObject({
      kind: 'refused',
      role: 'editor',
      reason: 'editor-already-bound',
    });

    // every role's document injects exactly ITS OWN capability after
    // JavaScript request construction; the unbound window injects
    // nothing, and no forged value leaves any host.
    await probe(run, 'editor', 'e1');
    await probe(run, 'd1', 'd1a');
    await probe(run, 'd2', 'd2a');
    await probe(run, 'd3', 'd3a');
    await probe(run, 'd4', 'd4a');
    expect(clientHeaderPairs(origin.byLabel('e1'))).toHaveLength(1);
    expect(clientHeaderPairs(origin.byLabel('e1'))[0]?.value).toBe(editor.capability);
    expect(clientHeaderPairs(origin.byLabel('d1a'))[0]?.value).toBe(d1.capability);
    expect(clientHeaderPairs(origin.byLabel('d2a'))[0]?.value).toBe(d2.capability);
    expect(clientHeaderPairs(origin.byLabel('d3a'))[0]?.value).toBe(d3.capability);
    expect(clientHeaderPairs(origin.byLabel('d4a'))).toHaveLength(0);
    for (const label of ['e1', 'd1a', 'd2a', 'd3a', 'd4a']) {
      expect(carriesForgedValue(origin.byLabel(label))).toBe(false);
    }

    // THE SWITCH: the session is replaced — every role's binding dies
    // TOGETHER, and no dead capability leaves the host afterwards.
    run.send({ op: 'session-replaced', epoch: 'k3-epoch', generation: 1 });
    await run.waitFor((event) => event.kind === 'replaced', 'the session replacement');
    expect(await injected(run, 'editor')).toBeNull();
    expect(await injected(run, 'd1')).toBeNull();
    expect(await injected(run, 'd2')).toBeNull();
    expect(await injected(run, 'd3')).toBeNull();
    await probe(run, 'editor', 'e2');
    expect(clientHeaderPairs(origin.byLabel('e2'))).toHaveLength(0);
    expect(carriesForgedValue(origin.byLabel('e2'))).toBe(false);

    // the successor session REBINDS: the editor and the diagnostics
    // mint FRESH capabilities (never a revival), the caps hold again,
    // and the live documents inject the new values — while a renderer
    // forging the OLD editor value leaves with the NEW capability.
    run.send({ op: 'set-session', epoch: 'k3-epoch', generation: 2 });
    const editorNext = expectBound(await bind(run, 'bind-editor', 'editor'), 'editor');
    const d1Next = expectBound(await bind(run, 'bind-diagnostic', 'd1'), 'd1');
    const d2Next = expectBound(await bind(run, 'bind-diagnostic', 'd2'), 'd2');
    const d3Next = expectBound(await bind(run, 'bind-diagnostic', 'd3'), 'd3');
    expect(editorNext.capability).not.toBe(editor.capability);
    expect(d1Next.capability).not.toBe(d1.capability);
    expect(d2Next.capability).not.toBe(d2.capability);
    expect(d3Next.capability).not.toBe(d3.capability);
    const d4Next = await bind(run, 'bind-diagnostic', 'd4');
    expect(d4Next).toMatchObject({ kind: 'refused', reason: 'diagnostics-full' });

    await probe(run, 'editor', 'e3', editor.capability);
    expect(clientHeaderPairs(origin.byLabel('e3'))).toHaveLength(1);
    expect(clientHeaderPairs(origin.byLabel('e3'))[0]?.value).toBe(editorNext.capability);
    await probe(run, 'd1', 'd1b');
    expect(clientHeaderPairs(origin.byLabel('d1b'))[0]?.value).toBe(d1Next.capability);
  }, 120_000);

  it('disables edits fail-closed on revocation and navigation — and every rebinding is a fresh mint', async () => {
    const run = await launchWindowedRun();

    const editor = expectBound(await bind(run, 'bind-editor', 'editor'), 'editor');
    const d1 = expectBound(await bind(run, 'bind-diagnostic', 'd1'), 'd1');
    const d2 = expectBound(await bind(run, 'bind-diagnostic', 'd2'), 'd2');
    expectBound(await bind(run, 'bind-diagnostic', 'd3'), 'd3');

    // the CDP-detach face: a revoked capability dies INSTANTLY for its
    // document alone — the other documents' authority is untouched.
    run.send({ op: 'revoke', id: 'd1' });
    await run.waitFor(
      (event) => event.kind === 'state' && event.id === 'd1' && event.injectable === null,
      'the revoked diagnostic dead binding',
    );
    await probe(run, 'd1', 'r1');
    await probe(run, 'd2', 'r2');
    expect(clientHeaderPairs(origin.byLabel('r1'))).toHaveLength(0);
    expect(carriesForgedValue(origin.byLabel('r1'))).toBe(false);
    expect(clientHeaderPairs(origin.byLabel('r2'))[0]?.value).toBe(d2.capability);

    // the recovery is a FRESH mint at the same document — never a
    // revival of the revoked capability.
    const d1Rebound = expectBound(await bind(run, 'bind-diagnostic', 'd1'), 'd1');
    expect(d1Rebound.capability).not.toBe(d1.capability);
    await probe(run, 'd1', 'r3');
    expect(clientHeaderPairs(origin.byLabel('r3'))[0]?.value).toBe(d1Rebound.capability);

    // a top-level navigation kills the navigated document's binding;
    // the rebind at the NEW navigation is again a fresh mint.
    run.send({ op: 'load', id: 'd2', url: `${origin.origin}/?window=d2&page=2` });
    await run.waitFor(
      (event) => event.kind === 'loaded' && event.id === 'd2',
      'the diagnostic navigation',
    );
    expect(await injected(run, 'd2')).toBeNull();
    const d2Rebound = expectBound(await bind(run, 'bind-diagnostic', 'd2'), 'd2');
    expect(d2Rebound.capability).not.toBe(d2.capability);

    // a REAL renderer crash kills that document's authority; the
    // editor's is untouched and still injecting.
    run.send({ op: 'crash', id: 'd3' });
    await run.waitFor(
      (event) => event.kind === 'state' && event.id === 'd3' && event.injectable === null,
      'the crashed diagnostic dead binding',
    );
    await probe(run, 'editor', 'r4');
    expect(clientHeaderPairs(origin.byLabel('r4'))[0]?.value).toBe(editor.capability);

    // and destroying a target kills its binding with it — the port's
    // own truth, observed after the real event.
    run.send({ op: 'destroy', id: 'd2' });
    await run.waitFor(
      (event) => event.kind === 'state' && event.id === 'd2' && event.injectable === null,
      'the destroyed target dead binding',
    );
  }, 120_000);
});
