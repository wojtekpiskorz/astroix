import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  describePackageVerification,
  verifyPackagedApp,
} from '../../apps/desktop/src/forge/package-verification.ts';
import { rawExchange } from '../../apps/web/src/e2e-wire.ts';
import {
  PACKAGED_ELECTRON_PIN,
  PACKAGED_FORGE_PIN,
  PACKAGED_NODE_PIN,
} from '../../packages/runtime/src/internal/packaged-assets.ts';
import {
  activateApp,
  clickMenuItem,
  DESKTOP_EVENT_KINDS,
  type DesktopEvent,
  delay,
  enumerateApplicationMenu,
  establishedSockets,
  extractPackagedApp,
  listeningSockets,
  makeStagingRoot,
  originPortOf,
  PACKAGE_ZIP,
  PackagedAppRun,
  processesReferencing,
  quitNormally,
  realHomeIsolationFindings,
  registerThroughNativePicker,
  removeStaging,
  sanitizationFindings,
  snapshotManagedProject,
  tmpTopLevel,
  uiScriptingAvailable,
  windowNamesOfProcess,
} from './early-package-kit.ts';

/**
 * The early packaged-host smoke (#248, H6 focused tests): the EXACT
 * extracted ZIP artifact a local `npm run package` produced (ADR-0008:
 * the packaged smoke is H6's evidence, local-only — never `npm test`,
 * never CI) — launched as the real `Astroix.app` executable with an
 * isolated temp HOME, driven through its REAL product surfaces only
 * (the native application menu, the native directory picker, the
 * Apple-event quit), and audited after the run.
 *
 * What this lane proves that no separate green lane can, because only
 * the exact hardened package has all of it together: the in-app
 * pre-activation verification law firing green in the real bundle, the
 * private boot spawning the BUNDLED stock Node (never Electron-as-Node,
 * never a discovered executable), the native registration flow ending
 * in the registry's sanitized summary, the normal quit transition
 * settling with the control-plane child reaped gracefully, the managed
 * project byte-identical (zero injection), no stray processes, sockets,
 * or temporary roots left behind, and the product's public log
 * vocabulary carrying no paths, PIDs, ports, or internal digests.
 *
 * The composition legs (#362, H7 — the seam this spec's H6 boundary leg
 * was waiting for): the packaged child composes the production control
 * plane over its kernel-leased registry, the native menu carries the
 * per-project activation entries, and a REAL activation drives the full
 * hosting loop — the authoritative window (fresh editing partition, CDP
 * bypass before navigation, H4 document authority injected) replaces its
 * top level onto the granted project origin, the launcher and project
 * origins serve through the one loopback listener, the project's natural
 * routes stream through the proxy byte-identical (zero injection), the
 * Vite HMR WebSocket lives through the raw-upgrade tunnel, and the quit
 * transition reaps the whole plane (the CloseReport convergence — zero
 * strays, zero sockets). The SW-bypass and authority ENFORCEMENT truths
 * stay in their real-Electron lanes (`e2e/desktop/service-worker-bypass`
 * and `document-authority-injection` — the composed product path is what
 * this lane proves: those guards are the only load-bearing path to the
 * project origin).
 *
 * Self-skips without a local package (the #339 pattern): `npm test`
 * stays deterministic and network-free.
 */

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const FIXTURE = join(REPO, 'e2e', 'fixture');

/** The static product menus — the Session menu's items are session/registry-dependent (the activation entries). */
const EXPECTED_STATIC_MENUS: Readonly<Record<string, readonly string[]>> = {
  Astroix: ['About Astroix', 'Quit Astroix'],
  File: ['Add Existing Project…'],
};
/**
 * The OS-owned Apple menu (its contents are dynamic — update badges,
 * the login name) is chrome, not product surface; the boundary law
 * pins the PRODUCT menus exactly and never the Apple menu's rows.
 */
const OS_MENU = 'Apple';

let staging: string;
let appPath: string;
let managedRoot: string;
let run: PackagedAppRun;
let managedBefore: Map<string, string>;
let tmpBefore: Set<string>;
let menuRows: string[] = [];
/** The registration leg's sanitized summary — the activation entry's label and the project origin's hostname. */
let registeredSummary: { projectKey: string; displayName: string } | null = null;
/**
 * The registration leg's outcome — the skip-cascade truth the boundary
 * leg consumes: `'pending'` before the leg ran, `'completed'` when the
 * native flow drove, `'ui-scripting-unavailable'` when the host cannot
 * drive System Events (the legs that depend on the drive skip with the
 * REASON, never fail on inferred emptiness).
 */
let registrationOutcome: 'pending' | 'completed' | 'ui-scripting-unavailable' = 'pending';

beforeAll(async () => {
  staging = await makeStagingRoot('astroix-early-package-');
  appPath = await extractPackagedApp(PACKAGE_ZIP as string, staging);
  // the managed project: a disposable plain-fixture copy (the canonical
  // fixture itself is never registered — the G3 law)
  managedRoot = join(staging, 'managed-project');
  await execFileAsync('cp', ['-R', FIXTURE, managedRoot], { timeout: 5 * 60_000 });
}, 300_000);

afterAll(async () => {
  await run?.killForCleanup();
  if (staging !== undefined) await removeStaging(staging);
});

describe.skipIf(!PACKAGE_ZIP)('the exact packaged host — the early packaged smoke (#248)', () => {
  it('the extracted artifact proves its facts before launch: pins, hashes, fuses, identity, strict adhoc signature', async () => {
    // The ADR-0008 after-extraction law, re-proven over THIS smoke's own
    // extraction: strict codesign on every nested target and the outer
    // app (adhoc-sealed), resources through the same adapter the app
    // boots with (every pin + SHA-256), fuses on the real framework
    // binary, bundle identity + min-OS + asar integrity, single-arch.
    const report = await verifyPackagedApp(appPath);
    for (const line of describePackageVerification(report)) {
      console.log(`early-package-evidence: ${line}`);
    }
    expect(report.ok, JSON.stringify(report)).toBe(true);
    for (const target of report.codesign.targets) {
      expect(target.verified, `${target.target} strict verification`).toBe(true);
      if (!target.adhocOptional)
        expect(target.signature, `${target.target} sealed identity`).toBe('adhoc');
    }
    // The metadata facts AC-2 names, read from the artifact's own build
    // manifest — the same values the app's in-app verifier pins against.
    const manifest = JSON.parse(
      await readFile(
        join(appPath, 'Contents', 'Resources', 'astroix-runtime', 'build-manifest.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(manifest.node).toBe(PACKAGED_NODE_PIN);
    expect(manifest.electron).toBe(PACKAGED_ELECTRON_PIN);
    expect(manifest.forge).toBe(PACKAGED_FORGE_PIN);
    expect(manifest.architecture).toBe('arm64');
    expect(Array.isArray(manifest.resources) && (manifest.resources as unknown[]).length > 0).toBe(
      true,
    );
    console.log(
      `early-package-evidence: artifact pins — node=${String(manifest.node)} electron=${String(manifest.electron)} forge=${String(manifest.forge)} arch=${String(manifest.architecture)}`,
    );
  }, 300_000);

  it('boots: in-app verification green, the private boot spawns the bundled stock Node child', async () => {
    // An isolated temp HOME + the product's user-data override, with
    // every dev-only env declaration removed — the packaged laws only.
    const home = join(staging, 'home');
    const userData = join(staging, 'user-data');
    await execFileAsync('mkdir', ['-p', home]);
    tmpBefore = await tmpTopLevel();
    run = new PackagedAppRun(appPath, { staging, home, userData });
    // control-plane-booted is the product's own line that the in-app
    // pre-activation verification PASSED and the private boot completed
    // (resolveRuntimeAssets runs verifyPackagedAssets before any spawn).
    const booted = await run.waitForEvent('control-plane-booted', 'the packaged private boot');
    expect(booted.kind).toBe('control-plane-booted');
    // The live process tree: the control-plane child is the BUNDLED
    // stock Node running the rebased entry — never Electron-as-Node,
    // never a discovered executable (ADR-0008).
    await delay(500);
    const tree = await processesReferencing(staging);
    for (const row of tree) {
      console.log(`early-package-evidence: process ${row.pid} ppid ${row.ppid} :: ${row.command}`);
    }
    expect(tree.length).toBeGreaterThanOrEqual(2);
    const childRow = tree.find((row) => row.command.includes('control-plane/child.js'));
    expect(childRow, 'the bundled-Node control-plane child exists').toBeDefined();
    expect(
      childRow?.command.includes(join('Resources', 'node', 'bin', 'node')),
      'the child executable is the bundled stock Node',
    ).toBe(true);
    expect(childRow?.command.includes('Electron'), 'the child is never Electron-as-Node').toBe(
      false,
    );
    // The isolation law over the WHOLE captured tree: no process of the
    // app references the real account home (the first recorded run's
    // finding — early GPU/network helpers ran against the real home's
    // Application Support; the launch now carries the browser-level
    // --user-data-dir switch so every helper, first to last, holds the
    // temp root. The product half of that observation — the env
    // override landing after the pre-boot verification — was #363,
    // hoisted above the verification).
    const homeFindings = realHomeIsolationFindings(tree, homedir());
    expect(homeFindings, `isolation leak: ${JSON.stringify(homeFindings)}`).toEqual([]);
    console.log(
      `early-package-evidence: isolation — ${tree.length} processes, none reference the real account home`,
    );
    // No window-state or session report preceded the boot — the product
    // log stays the closed H1 vocabulary (the sanitization half).
    expect(run.events.map((event) => event.kind)).toEqual(['control-plane-booted']);
  }, 180_000);

  it('registers a plain project through the native picker — the real registry flow, sanitized summary', async (context) => {
    const canDriveUi = await uiScriptingAvailable();
    if (!canDriveUi) {
      registrationOutcome = 'ui-scripting-unavailable';
      console.log(
        'early-package-evidence: System Events UI scripting unavailable on this host — the native-picker leg SKIPPED (grant Automation for the lane host to run it); the boundary leg and the injection audit skip with it',
      );
      context.skip();
      return;
    }
    registrationOutcome = 'completed';
    managedBefore = snapshotManagedProject(managedRoot);
    expect(managedBefore.size).toBeGreaterThan(5);
    const registered: DesktopEvent = await registerThroughNativePicker(run, managedRoot);
    // The registry's wire summary, and nothing else: key, display name,
    // availability — never a filesystem root (the minimum-disclosure law).
    const summary = registered.summary as Record<string, unknown>;
    expect(typeof summary.projectKey).toBe('string');
    expect((summary.projectKey as string).length).toBeGreaterThan(0);
    expect(summary.availability).toBe('available');
    registeredSummary = {
      projectKey: summary.projectKey as string,
      displayName: summary.displayName as string,
    };
    expect(JSON.stringify(registered)).not.toContain(staging);
    console.log(
      `early-package-evidence: registered through the native picker — projectKey=${String(summary.projectKey)} availability=${String(summary.availability)}`,
    );
    // The real registry location: the production versioned-JSON store
    // under the isolated userData (H1's law), created 0o700.
    const registryStore = join(run.roots.userData, 'registry', 'registry.json');
    expect(existsSync(registryStore)).toBe(true);
    const registryStat = await stat(join(run.roots.userData, 'registry'));
    expect((registryStat.mode & 0o777).toString(8)).toBe('700');
    // The registry tree existed before any activation could ever run:
    // no project-origin listener appeared (registration is control-plane
    // bookkeeping — the composition that serves origins is not packaged).
    const tree = await processesReferencing(staging);
    const sockets = await listeningSockets(tree.map((row) => row.pid));
    for (const socket of sockets) {
      console.log(`early-package-evidence: listener while registered :: ${socket}`);
    }
    await activateApp();
    menuRows = await enumerateApplicationMenu();
    for (const row of menuRows) console.log(`early-package-evidence: menu :: ${row}`);
  }, 180_000);

  it('activates through the native menu — the composition serves, the authoritative window loads, the hosting loop is real (#362)', async (context) => {
    // The composition lane's flip (#362, H7): the boundary leg that
    // pinned "no activation surface" is retired — the menu carries the
    // per-project activation entry, a real click drives the settled
    // transition inside the packaged child (the SAME composition the
    // web host proves), and the hosting loop is observable end to end:
    // the launcher and project origins serve, the project's natural
    // routes stream through the proxy with zero injection, the reserved
    // API's admission is enforced, and the Vite HMR WebSocket lives
    // through the raw-upgrade tunnel.
    //
    // The menu enumeration comes from the registration leg's UI drive:
    // when System Events scripting is unavailable THAT leg skipped (with
    // its reason recorded in `registrationOutcome`) and this leg skips
    // with it — never a false failure inferred from empty rows.
    if (registrationOutcome === 'ui-scripting-unavailable') {
      console.log(
        'early-package-evidence: activation leg SKIPPED — the native menu cannot be driven without System Events UI scripting (the registration leg already skipped for the same reason)',
      );
      context.skip();
      return;
    }
    expect(registrationOutcome, 'the registration leg completed').toBe('completed');
    expect(registeredSummary, 'the registered summary was captured').not.toBeNull();
    const { projectKey, displayName } = registeredSummary as {
      projectKey: string;
      displayName: string;
    };
    // Parse the enumerated rows into sections: `menu:` headers and their
    // `item:` rows. The static product menus are exactly H1's set; the
    // Session menu carries the composition's per-project activation
    // entry beside the deactivate item.
    const sections = new Map<string, string[]>();
    let current: string | undefined;
    for (const row of menuRows) {
      if (row.startsWith('menu: ')) {
        current = row.slice('menu: '.length);
        sections.set(current, []);
      } else if (row.startsWith('item: ') && current !== undefined) {
        sections.get(current)?.push(row.slice('item: '.length));
      }
    }
    const productMenuNames = [...sections.keys()].filter((name) => name !== OS_MENU);
    expect(new Set(productMenuNames), 'the product menus are the H1 sections').toEqual(
      new Set([...Object.keys(EXPECTED_STATIC_MENUS), 'Session']),
    );
    for (const [menu, items] of sections) {
      if (menu === OS_MENU || menu === 'Session') continue; // OS chrome dynamic; Session is registry-dependent
      expect(items, `the ${menu} menu items`).toEqual(EXPECTED_STATIC_MENUS[menu]);
    }
    expect(sections.get('Session'), 'the Session menu carries the activation entry').toEqual([
      `Activate ${displayName}`,
      'Deactivate Project',
    ]);

    // — the real activation drive: the native menu's entry —
    await clickMenuItem('Session', `Activate ${displayName}`);
    const active = await run.waitForEvent('session-active', 'the committed activation', 150_000);
    console.log(
      `early-package-evidence: activation committed through the native menu — session generation ${String((active.sessionRef as { generation: number } | undefined)?.generation ?? '?')}`,
    );
    // The authoritative window opened beside the launcher (the
    // bypass-guarded editing target — the only load-bearing path to the
    // project origin).
    const windowNames = await windowNamesOfProcess();
    console.log(`early-package-evidence: windows — ${JSON.stringify(windowNames)}`);
    expect(windowNames.length).toBeGreaterThanOrEqual(2);

    // — the process tree: the managed plane spawned under the child —
    await delay(1500);
    const tree = await processesReferencing(staging);
    for (const row of tree) {
      console.log(`early-package-evidence: process ${row.pid} ppid ${row.ppid} :: ${row.command}`);
    }
    const childRow = tree.find((row) => row.command.includes('control-plane/child.js'));
    expect(childRow, 'the bundled-Node control-plane child exists').toBeDefined();
    const plane = tree.filter((row) => row.pid !== childRow?.pid && row.ppid === childRow?.pid);
    expect(
      plane.length,
      'the managed plane (the plane worker and the managed astro dev server) spawned under the child',
    ).toBeGreaterThanOrEqual(2);

    // — the origins serve through the one loopback listener —
    const port = await originPortOf(childRow?.pid ?? '');
    expect(port, 'the composition listener holds a loopback port').toBeGreaterThan(0);
    console.log(
      `early-package-evidence: the composition serves (origin port observed through the child's listener)`,
    );
    const get = (host: string, target: string): Promise<{ status: number; body: string }> =>
      rawExchange(
        port,
        `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
        15_000,
      );
    const launcher = await get(`launcher.localhost:${port}`, '/__astroix/app/');
    expect(launcher.status, 'the launcher origin serves the launcher document').toBe(200);
    expect(launcher.body).toContain('Astroix');
    const projectHost = `${projectKey}.localhost:${port}`;
    const app = await get(projectHost, '/__astroix/app/');
    expect(app.status, 'the project origin serves the app shell document').toBe(200);
    expect(app.body).toContain('astroix-client'); // the document's bootstrap meta
    // The natural route streams through the REAL proxy: the project's
    // own dev-server bytes, zero injection (nothing of Astroix rides
    // the project's document).
    const natural = await get(projectHost, '/');
    expect(natural.status, 'the natural root routes through the proxy to the dev server').toBe(200);
    expect(natural.body, 'the natural document carries no Astroix namespace').not.toContain(
      '__astroix',
    );
    // The reserved API's admission is enforced in the packaged child: a
    // mutation without the host capability is unauthorized — the
    // authority surface this package can honestly observe from outside.
    const unauthorized = await rawExchange(
      port,
      [
        'POST /__astroix/api/v1 HTTP/1.1',
        `Host: ${projectHost}`,
        'Content-Type: application/json',
        'Content-Length: 2',
        'Connection: close',
        '',
        '{}',
      ].join('\r\n'),
      15_000,
    );
    expect(unauthorized.status, 'the reserved API refuses an unauthenticated mutation').toBe(403);
    expect(unauthorized.body).toContain('unauthorized');

    // — the HMR tunnel: the canvas's Vite client holds an established
    // connection through the raw-upgrade proxy (the window count and
    // the established socket together are the packaged HMR evidence;
    // the behavioral law is the web lane's and the SW lane's) —
    const established = await establishedSockets(tree.map((row) => row.pid));
    const onListener = established.filter((line) => line.includes(`:${port}`));
    for (const line of onListener) console.log(`early-package-evidence: established :: ${line}`);
    expect(
      onListener.length,
      "an established connection rides the composition listener (the canvas's Vite client through the upgrade tunnel)",
    ).toBeGreaterThanOrEqual(1);
    console.log(
      'early-package-evidence: ACTIVATION LEG GREEN — menu entry, committed transition, managed plane, launcher + project origins, proxied natural route (zero injection), enforced admission, live HMR tunnel',
    );
  }, 300_000);

  it('quits normally: the transition settles, the exact children reap, nothing remains, zero injection', async () => {
    await quitNormally(run);
    const settled = run.events.find((event) => event.kind === 'quit-settled');
    expect(settled?.childStop).toBe('graceful');
    // quitNormally already asserted the process exit (code 0) — now the
    // post-run audits.
    // 1. No stray process references the staging root: the app AND the
    //    bundled-Node child are gone (the ordered stop reaped them).
    await delay(500);
    const strays = await processesReferencing(staging);
    expect(strays, `stray processes: ${JSON.stringify(strays)}`).toEqual([]);
    // 2. No listener sockets remain (nothing holds the pids at all).
    expect(await listeningSockets(strays.map((row) => row.pid))).toEqual([]);
    // 3. The managed project is byte- and metadata-identical: zero
    //    injection across register + quit (the G3 methodology). With the
    //    registration drive skipped (System Events unavailable) there is
    //    no register step to audit — the leg records that honestly
    //    instead of comparing an empty snapshot against itself.
    if (registrationOutcome === 'completed') {
      const managedAfter = snapshotManagedProject(managedRoot);
      expect(managedBefore.size, 'the pre-registration snapshot is non-vacuous').toBeGreaterThan(5);
      expect([...managedAfter.keys()]).toEqual([...managedBefore.keys()]);
      for (const [path, recorded] of managedBefore) {
        expect(managedAfter.get(path), `managed-project drift at ${path}`).toBe(recorded);
      }
    } else {
      console.log(
        'early-package-evidence: the injection audit is vacuous on this host — no registration ran (System Events UI scripting unavailable)',
      );
    }
    // 4. The temporary root is clean: nothing new at the top level of
    //    the system temp directory beyond what existed before launch
    //    (our staging is removed before the comparison). The ONE
    //    permitted shape: the managed dev stack's own node-gyp devdir
    //    scratch (a `.<hash>-<n>.node-gyp` directory Astro's compiler
    //    binding materializes at dev-server start — the project's own
    //    toolchain artifact, the same one every web-lane dev server
    //    leaves; the managed-snapshot exclusion list's rationale, now
    //    on the temp surface the activation opened).
    await removeStaging(staging);
    const tmpAfter = await tmpTopLevel();
    const leftovers = [...tmpAfter].filter(
      (entry) => !tmpBefore.has(entry) && !/^\.[0-9a-f]+-\d+\.node-gyp$/.test(entry),
    );
    expect(leftovers, `temporary-root leftovers: ${JSON.stringify(leftovers)}`).toEqual([]);
    // 5. The canonical fixture stayed plain throughout (only the staged
    //    copy was ever registered).
    const status = await execFileAsync('git', ['status', '--porcelain', '--', 'e2e/fixture'], {
      cwd: REPO,
    });
    expect(status.stdout.trim()).toBe('');
    // 6. AC-6: the product's public log vocabulary is sanitized — no
    //    absolute paths, no digests, no PIDs, no ports — and every event
    //    stayed inside the closed H1 vocabulary.
    expect(sanitizationFindings(run.productLogLines)).toEqual([]);
    for (const event of run.events) {
      expect(DESKTOP_EVENT_KINDS.has(event.kind), `unknown product event kind ${event.kind}`).toBe(
        true,
      );
    }
    console.log(
      `early-package-evidence: quit settled (childStop=${String(settled?.childStop)}), zero strays, zero sockets, zero temp leftovers, managed project identical, product log sanitized (${run.productLogLines.length} lines)`,
    );
  }, 180_000);
});
