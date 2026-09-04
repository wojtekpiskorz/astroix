import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildClientDocuments } from '../../apps/web/src/client-build.ts';
import { stagedFixtureCopy } from '../../apps/web/src/stage-e2e.ts';
import { buildHarnessMain, freePort, HarnessRun, REPO } from './harness-kit.ts';

/**
 * The CSS inspection real-Electron lane (#249, I1 focused tests): the
 * REAL Electron 44.1.0 binary (the workspace's pinned one, ADR-0008)
 * over a REAL hardened window, driving the REAL product flow — the
 * launcher's own Activate button runs the real transition, the project
 * document is the real client build (the app shell with the CSS
 * vertical's panel), the canvas is the real same-origin iframe on the
 * real project origin, and the selection is the real click capture.
 * Behind the window: the SHARED control-plane composition booted FROM
 * SOURCE in a real stock-Node child (the web host's own boot argv — a
 * bundle would break the composition's import.meta.url worker
 * resolution) over an isolated test registry with a staged fixture copy
 * (the web lane's own `stagedFixtureCopy` — sources copied,
 * installation symlinked back, the shared discipline) and the web
 * host's own client-build config (`buildClientDocuments`), never the
 * kernel-backed production registry and never the canonical fixture.
 *
 * What only this lane can prove: the CSS vertical's panel and the
 * canvas selection behave identically inside the real Electron
 * renderer (hardened preferences, real Chromium) — the joined list
 * with its scoped effective form, the deterministic order, sanitized
 * locations, and the READ-ONLY law (no edit control, no disclosure of
 * module-graph or filesystem shapes).
 *
 * Lane gate, never release evidence (ADR-0008) — runs behind `npm run
 * test:desktop`'s config like the other real-Electron lanes.
 */

const PLANE_ENTRY = join(REPO, 'e2e', 'desktop', 'fixtures', 'css-inspection-plane.ts');
const HARNESS_ENTRY = join(REPO, 'e2e', 'desktop', 'fixtures', 'css-inspection-harness.ts');
const REGISTER_MODULE = join(REPO, 'apps', 'web', 'raw-node-register.mjs');
const REPORT_PREFIX = 'astroix-css-harness: ';

interface PanelReport {
  readonly kind: 'panel';
  readonly panel: {
    readonly state: string;
    readonly rows: ReadonlyArray<{
      readonly selector: string | null;
      readonly effective: string | null;
      readonly media: string | null;
      readonly file: string | null;
      readonly line: string | null;
      readonly winner: boolean;
    }>;
    readonly text: string;
    readonly editable: number;
  };
}

let run: HarnessRun | null = null;
let scratchRoot: string;

beforeAll(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), 'astroix-css-electron-'));
  const fixtureCopy = await stagedFixtureCopy(scratchRoot, 'fixture-copy');
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

/** One panel read, waited out of its settle-poll. */
async function readPanel(): Promise<PanelReport['panel']> {
  const current = run;
  if (current === null) throw new Error('the harness is not running');
  current.send({ op: 'panel' });
  const event = (await current.waitFor(
    (candidate) => candidate.kind === 'panel',
    'the panel report',
    180_000,
  )) as unknown as PanelReport;
  return event.panel;
}

describe('the CSS inspection panel — real Electron, real composition, real canvas', () => {
  it('activates through the launcher and renders the joined read-only truth for a canvas selection', async () => {
    const current = run;
    if (current === null) throw new Error('the harness is not running');

    // The product flow: the launcher's OWN button drives the real
    // transition; the harness observes the settled project document.
    current.send({ op: 'activate' });
    await current.waitFor((event) => event.kind === 'activated', 'the activation', 180_000);

    // The real click capture in the real canvas: the doubly-styled hero
    // title, through the same-origin iframe the shell hosts.
    current.send({ op: 'select', selector: '.hero-title' });
    const selected = await current.waitFor(
      (event) => event.kind === 'selected',
      'the canvas selection',
      60_000,
    );
    expect(selected.selection).toMatchObject({ tag: 'h1' });

    // The joined list: scoped effective form first as the winner, the
    // three global occurrences in payload order (one media-conditioned),
    // sanitized project-relative locations everywhere.
    const panel = await readPanel();
    expect(panel.state).toBe('ready');
    expect(panel.rows).toHaveLength(4);
    const winner = panel.rows[0];
    expect(winner?.winner).toBe(true);
    expect(winner?.selector).toBe('.hero-title');
    expect(winner?.effective).toMatch(/^\.hero-title\[data-astro-cid-[a-z0-9]+\]$/);
    expect(winner?.file).toBe('src/pages/index.astro');
    expect(winner?.line).toBe('24');
    expect(panel.rows.slice(1).every((row) => row.file === 'src/pages/home.css')).toBe(true);
    expect(panel.rows.slice(1).filter((row) => row.winner)).toHaveLength(0);
    expect(panel.rows.filter((row) => row.media === '(max-width: 640px)')).toHaveLength(1);
    expect(panel.rows.slice(1).every((row) => row.effective === '')).toBe(true);

    // The disclosure sweep — nothing the module graph or the filesystem
    // owns renders — and the read-only law: no editable control exists.
    expect(panel.text).not.toContain('node_modules');
    expect(panel.text).not.toContain('routeComponent');
    expect(panel.text).not.toContain('virtual:astro');
    expect(panel.text).not.toMatch(/\/(Users|home|srv|mnt|private)\//);
    expect(panel.editable).toBe(0);
  }, 420_000);
});
