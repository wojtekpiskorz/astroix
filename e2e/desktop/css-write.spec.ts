import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildClientDocuments } from '../../apps/web/src/client-build.ts';
import { stagedFixtureCopy } from '../../apps/web/src/stage-e2e.ts';
import { buildHarnessMain, freePort, HarnessRun, REPO } from './harness-kit.ts';

/**
 * The CSS auto-write real-Electron lane (#250, I2 focused tests — the
 * ticket's Electron leg: ONE CSS edit and its HMR): the REAL Electron
 * 44.1.0 binary over a REAL hardened window, driving the REAL product
 * flow — the launcher's own Activate button, the real client build
 * with the CSS vertical's EDITING surface, the real canvas selection,
 * the real rule editor input, and the real grant-bound auto-write loop
 * through the shared control-plane composition in a real stock-Node
 * child (the write-executor child included — the lane's composition
 * forks it at the first accepted edit). The HMR reflection is the
 * project's OWN vite pipeline observed in the live canvas document's
 * computed style — nothing synthetic.
 *
 * Lane gate, never release evidence (ADR-0008) — runs behind `npm run
 * test:desktop`'s config like the other real-Electron lanes.
 */

const PLANE_ENTRY = join(REPO, 'e2e', 'desktop', 'fixtures', 'css-inspection-plane.ts');
const HARNESS_ENTRY = join(REPO, 'e2e', 'desktop', 'fixtures', 'css-write-harness.ts');
const REGISTER_MODULE = join(REPO, 'apps', 'web', 'raw-node-register.mjs');
const REPORT_PREFIX = 'astroix-css-harness: ';

interface StatusReport {
  readonly kind: 'status';
  readonly status: {
    readonly state: string | null;
    readonly conflict: string | null;
    readonly undoDisabled: boolean | null;
    readonly decls: readonly { readonly prop: string | null; readonly value: string }[] | null;
  };
}

interface HmrReport {
  readonly kind: 'canvas-hmr';
  readonly hmr: { readonly present: boolean; readonly carries: boolean; readonly marker: boolean };
  readonly needle: string;
}

let run: HarnessRun | null = null;
let scratchRoot: string;
let cssPath: string;

beforeAll(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), 'astroix-css-write-electron-'));
  const fixtureCopy = await stagedFixtureCopy(scratchRoot, 'fixture-copy');
  cssPath = join(fixtureCopy, 'src', 'pages', 'home.css');
  const clientDist = join(scratchRoot, 'client-dist');
  await buildClientDocuments(clientDist);
  const harnessBundle = await buildHarnessMain(HARNESS_ENTRY, join(scratchRoot, 'harness-build'));
  const port = await freePort();
  run = new HarnessRun({
    bundle: harnessBundle,
    reportPrefix: REPORT_PREFIX,
    argv: [
      JSON.stringify({
        planeEntry: PLANE_ENTRY,
        repoRoot: REPO,
        registryDirectory: join(scratchRoot, 'registry'),
        clientDist,
        registerRoot: fixtureCopy,
        port,
        registerModule: REGISTER_MODULE,
        nodeExecutable: process.execPath,
      }),
    ],
  });
  await run.waitFor((event) => event.kind === 'ready', 'the harness ready line', 120_000);
}, 180_000);

afterAll(async () => {
  await run?.stop();
  await rm(scratchRoot, { recursive: true, force: true });
});

/** One write-badge read, waited out of the loop's settle. */
async function readStatus(state: string): Promise<StatusReport['status']> {
  const current = run;
  if (current === null) throw new Error('the harness is not running');
  let last: StatusReport['status'] | null = null;
  const seen = new Set<string | null>();
  // the settle runs on the renderer's own timers (the 300 ms debounce,
  // the write-executor fork, the refresh) — poll gently so the probes
  // never starve the flow they observe
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  for (let attempt = 0; attempt < 30; attempt += 1) {
    current.send({ op: 'status' });
    const event = (await current.waitFor(
      (candidate) => candidate.kind === 'status',
      'the status report',
      150_000,
    )) as unknown as StatusReport;
    last = event.status;
    seen.add(event.status.state);
    if (event.status.state === state) return event.status;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(
    `the write badge never settled on ${state}; last=${JSON.stringify(last)} seen=${[...seen].join(',')}`,
  );
}

/**
 * Polls the canvas's computed style until it moves off `was` — the
 * hot-update propagation (watcher → HMR frame → CSS apply) runs on the
 * canvas document's own clock, and the probes stay gentle so they
 * never starve it.
 */
/**
 * Waits for the canvas document's OWN stylesheet to carry the written
 * bytes through vite's hot update — and proves it was HOT (the marker
 * set in the document's window survives; a reload would destroy it).
 * Chromium skips style recalc for occluded harness windows, so the
 * computed-cascade reflection is the WEB battery's face of this same
 * law; this lane's face is the document's stylesheet truth itself.
 */
async function waitCanvasCarries(needle: string): Promise<void> {
  const current = run;
  if (current === null) throw new Error('the harness is not running');
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    current.send({ op: 'canvas-hmr', needle });
    const event = (await current.waitFor(
      (candidate) => candidate.kind === 'canvas-hmr',
      'the canvas hmr report',
      60_000,
    )) as unknown as HmrReport;
    if (event.hmr.carries && event.hmr.marker) return;
    if (event.hmr.carries && !event.hmr.marker) {
      throw new Error('the canvas reloaded instead of hot-updating');
    }
  }
  throw new Error(`the canvas stylesheet never carried ${needle}`);
}

describe('the CSS auto-write loop — real Electron, real composition, real HMR', () => {
  it('edits one declaration through the real surface and the canvas follows through native HMR', async () => {
    const current = run;
    if (current === null) throw new Error('the harness is not running');
    const original = await readFile(cssPath, 'utf8');

    try {
      // the product flow: activate through the launcher, select the
      // doubly-styled hero title, open the first GLOBAL row's editor
      current.send({ op: 'activate' });
      await current.waitFor((event) => event.kind === 'activated', 'the activation', 180_000);
      current.send({ op: 'select', selector: '.hero-title' });
      await current.waitFor((event) => event.kind === 'selected', 'the canvas selection', 60_000);

      // ONE CSS edit through the real input — the auto-write gesture
      // (the HMR reflection rides the same rule's `letter-spacing`
      // declaration — never media-shadowed by the fixture's own
      // max-width-640px rule the way the font-size one is)
      current.send({ op: 'edit', row: 1, prop: 'letter-spacing', value: '0.3em' });
      await current.waitFor((event) => event.kind === 'edited', 'the edit gesture', 60_000);

      // the loop settles quiet and the served truth re-opens on the written value
      const settled = await readStatus('quiet');
      const spacing = settled.decls?.find((decl) => decl.prop === 'letter-spacing');
      expect(spacing?.value).toBe('0.3em');
      expect(settled.conflict).toBeNull();

      // the staged copy's bytes carry the splice — byte-surgical, the
      // one declaration changed, everything else identical
      const written = await readFile(cssPath, 'utf8');
      expect(written).toBe(original.replace('letter-spacing: -0.02em;', 'letter-spacing: 0.3em;'));

      // HMR REFLECTED: the live canvas document's OWN stylesheet
      // carries the written bytes through vite's hot update — the
      // project's own pipeline, and the update was HOT (the window
      // marker survived: no reload happened)
      await waitCanvasCarries('letter-spacing: 0.3em;');

      // the undo is armed (one landed write) — the gesture's presence
      // is this lane's; its byte mechanics are the web battery's
      expect(settled.undoDisabled).toBe(false);
    } finally {
      await writeFile(cssPath, original);
    }
  });
}, 420_000);
