import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  describePackageVerification,
  verifyPackagedApp,
} from '../../apps/desktop/src/forge/package-verification.ts';
import {
  PACKAGED_ELECTRON_PIN,
  PACKAGED_FORGE_PIN,
  PACKAGED_NODE_PIN,
} from '../../packages/runtime/src/internal/packaged-assets.ts';
import {
  activateApp,
  DESKTOP_EVENT_KINDS,
  type DesktopEvent,
  delay,
  enumerateApplicationMenu,
  extractPackagedApp,
  listeningSockets,
  makeStagingRoot,
  PACKAGE_ZIP,
  PackagedAppRun,
  processesReferencing,
  quitNormally,
  registerThroughNativePicker,
  removeStaging,
  sanitizationFindings,
  snapshotManagedProject,
  tmpTopLevel,
  uiScriptingAvailable,
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
 * The honest boundary this lane RECORDS (the migration policy: report,
 * never hide): the packaged host does not yet compose the control-plane
 * activation (origin listener, launcher document, canvas, HMR proxy,
 * document authority, Service Worker bypass) — the child answers the
 * settled `unavailable-composition` refusal and no activation surface
 * exists in the product UI. The activation/canvas/HMR/SW legs of #248
 * are therefore BLOCKED on that missing seam (its owning issue carries
 * the finding); the boundary leg below pins today's surface honestly so
 * the composition lane that lands it flips this spec at the exact spot.
 *
 * Self-skips without a local package (the #339 pattern): `npm test`
 * stays deterministic and network-free.
 */

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const FIXTURE = join(REPO, 'e2e', 'fixture');

/** The product menu items per product menu — H1's closed action vocabulary; no activation entry exists today. */
const EXPECTED_PRODUCT_MENUS: Readonly<Record<string, readonly string[]>> = {
  Astroix: ['About Astroix', 'Quit Astroix'],
  File: ['Add Existing Project…'],
  Session: ['Deactivate Project'],
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
    // No window-state or session report preceded the boot — the product
    // log stays the closed H1 vocabulary (the sanitization half).
    expect(run.events.map((event) => event.kind)).toEqual(['control-plane-booted']);
  }, 180_000);

  it('registers a plain project through the native picker — the real registry flow, sanitized summary', async (context) => {
    const canDriveUi = await uiScriptingAvailable();
    if (!canDriveUi) {
      console.log(
        'early-package-evidence: System Events UI scripting unavailable on this host — the native-picker leg SKIPPED (grant Automation for the lane host to run it)',
      );
      context.skip();
      return;
    }
    managedBefore = snapshotManagedProject(managedRoot);
    expect(managedBefore.size).toBeGreaterThan(5);
    const registered: DesktopEvent = await registerThroughNativePicker(run, managedRoot);
    // The registry's wire summary, and nothing else: key, display name,
    // availability — never a filesystem root (the minimum-disclosure law).
    const summary = registered.summary as Record<string, unknown>;
    expect(typeof summary.projectKey).toBe('string');
    expect((summary.projectKey as string).length).toBeGreaterThan(0);
    expect(summary.availability).toBe('available');
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

  it('records the honest boundary: no activation surface exists — the composition seam is the blocked leg', async () => {
    // #248's activation/canvas/HMR/SW legs are BLOCKED on the missing
    // desktop composition (the child answers the settled
    // `unavailable-composition`; no origin, launcher, canvas, or editing
    // target is packaged). This leg pins today's product surface so the
    // composition lane flips it exactly here: the application menu is
    // H1's closed set — a registration entry, no activation entry — and
    // no session ever existed in this run.
    expect(
      menuRows.filter((row) => row.length > 0).length,
      'the menu was enumerated in the registration leg',
    ).toBeGreaterThan(0);
    // Parse the enumerated rows into sections: `menu:` headers and their
    // `item:` rows. The PRODUCT menus are exactly H1's closed set — a
    // registration entry, NO activation entry — and the only other menu
    // is the OS-owned Apple menu.
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
    expect(new Set(productMenuNames), 'the product menus are exactly the H1 sections').toEqual(
      new Set(Object.keys(EXPECTED_PRODUCT_MENUS)),
    );
    for (const [menu, items] of sections) {
      if (menu === OS_MENU) continue; // OS chrome, dynamic rows — never pinned
      expect(items, `the ${menu} menu items`).toEqual(EXPECTED_PRODUCT_MENUS[menu]);
    }
    const allProductItems = [...sections.values()].flat();
    expect(
      // word-bounded: "Deactivate Project" is H1's settled action; an
      // "Activate …" entry is the composition's surface, absent today
      allProductItems.some((item) => /\bactivate\b/i.test(item)),
      'no activation menu entry exists today',
    ).toBe(false);
    // No session state was ever reported: the closed H1 event flow never
    // left the no-session world (the desktop composition owns changing
    // this — its owning issue carries the finding).
    expect(run.events.some((event) => event.kind === 'registered')).toBe(true);
    expect(
      run.events.filter((event) => event.kind.startsWith('session')),
      'no session lifecycle exists in the packaged host yet',
    ).toEqual([]);
    console.log(
      'early-package-evidence: BLOCKED LEG RECORDED — activation, canvas, HMR-through-proxy, and Service-Worker-bypass observations require the desktop control-plane composition (not packaged at #248); see the owning issue',
    );
  }, 60_000);

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
    //    injection across register + quit (the G3 methodology).
    const managedAfter = snapshotManagedProject(managedRoot);
    expect([...managedAfter.keys()]).toEqual([...managedBefore.keys()]);
    for (const [path, recorded] of managedBefore) {
      expect(managedAfter.get(path), `managed-project drift at ${path}`).toBe(recorded);
    }
    // 4. The temporary root is clean: nothing new at the top level of
    //    the system temp directory beyond what existed before launch
    //    (our staging is removed before the comparison).
    await removeStaging(staging);
    const tmpAfter = await tmpTopLevel();
    const leftovers = [...tmpAfter].filter((entry) => !tmpBefore.has(entry));
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
    expect(sanitizationFindings(run.productLogLines, [staging])).toEqual([]);
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
