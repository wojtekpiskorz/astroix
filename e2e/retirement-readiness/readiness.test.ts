import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { validateContractFamilies } from './contracts.ts';
import { assembleCountsLedger, formatCountsLedger } from './counts.ts';
import { inventoryGaps, reconcileInventory } from './inventory.ts';

/**
 * The retirement-readiness suite, retained past the gate (#215, lane A6,
 * ADR-0010): the five serverless legs of the A5 aggregate proof
 * (`e2e/retirement-readiness.spec.ts`, #214), converted from Playwright to
 * vitest when the oracle world died at the retirement gate. Leg 6 (the live
 * disposable-oracle comparison) could not outlive the runtime it booted and
 * is gone; what these legs held at the gate they still hold after it:
 *
 *   1. contracts (serverless)  — every frozen family validates through its
 *      schema and re-derives through the RETAINED core (packages/core).
 *   2. retained UI (serverless)— the presentation surface carries zero
 *      runtime couplings; the presentation mounts run as a sibling file
 *      in this same vitest run (failures fail npm test; the counts leg
 *      holds the lane non-empty).
 *   3. fixture (serverless)    — the canonical fixture is plain and its
 *      production build carries zero astroix bytes.
 *   4. counts (serverless)    — every unit/contract/fixture lane is
 *      enumerated and non-empty.
 *   5. inventory (serverless) — the evidence report and the typed deletion
 *      inventory stay in agreement, and every deletion target the gate
 *      authorized is actually gone from the tree.
 *
 * The frozen corpora are no longer re-derivable — contract truth stopped
 * being re-derivable at the gate and became the frozen standard the web
 * host (#240) is judged against. Validating the standard is exactly these
 * legs' job.
 */

const FIXTURE = join('e2e', 'fixture');
const PRESENTATION_DIR = join('packages', 'app-shell', 'src', 'presentation');

test('contracts: every frozen family validates and re-derives through the retained core', () => {
  const ledger = validateContractFamilies();
  const families = ledger.map((row) => row.family).sort();
  expect(families).toEqual(['conflict', 'edit', 'inspection', 'output-byte', 'route', 'selector']);
  for (const row of ledger) {
    expect(row.fixtures.length, `${row.family} froze at least one fixture`).toBeGreaterThan(0);
    expect(row.checks, `${row.family} ran real checks`).toBeGreaterThan(0);
  }
  console.info(
    '[readiness] contract families:',
    ledger
      .map((row) => `${row.family}=${row.fixtures.length} fixtures/${row.checks} checks`)
      .join(' · '),
  );
});

test('retained UI: the presentation surface is uncoupled and runs over contract-shaped data', () => {
  // (a) the coupling scan: the presentation surface's runtime modules carry
  // no /__astroix URL, no fetch, no browser transport, no Vite handle —
  // data and callbacks in, contract-shaped rendering out.
  const forbidden: ReadonlyArray<{ token: string; what: string }> = [
    { token: '__astroix', what: 'a direct /__astroix endpoint reference' },
    { token: 'fetch(', what: 'a fetch call' },
    { token: 'import.meta', what: 'a bundler/Vite environment read' },
    { token: 'EventSource', what: 'an SSE transport' },
    { token: 'WebSocket', what: 'a websocket transport' },
    { token: 'window.', what: 'a global-window reach' },
    { token: 'navigator.', what: 'a navigator reach' },
  ];
  const testHelpers = new Set(['mount.tsx', 'fixtures.ts']); // test-only, never shipped through the barrel
  const offenders: string[] = [];
  const scanned: string[] = [];
  for (const entry of readdirSync(PRESENTATION_DIR, { withFileTypes: true })) {
    // the surface is FLAT: a subdirectory or non-TS module would silently
    // narrow the zero-coupling claim, so a shape change fails here instead
    if (entry.isDirectory()) {
      throw new Error(`unexpected directory in the presentation surface: ${entry.name}`);
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    if (entry.name.includes('.test.') || testHelpers.has(entry.name)) continue;
    scanned.push(entry.name);
    const text = readFileSync(join(PRESENTATION_DIR, entry.name), 'utf8');
    for (const { token, what } of forbidden) {
      if (text.includes(token)) offenders.push(`${entry.name}: ${what}`);
    }
  }
  expect(scanned.length, 'the coupling scan must cover real surface').toBeGreaterThan(0);
  expect(offenders, 'the presentation surface must stay runtime-uncoupled').toEqual([]);

  // (b) the mount lane: the presentation mounts run as a sibling file in
  // THIS SAME vitest run (presentation-mount.test.tsx joins the root
  // config — advisory round 1 on #291 deleted the vitest-spawns-vitest
  // detour the Playwright era needed), so a mount failure fails `npm
  // test` directly; the counts leg's non-empty mount row is the vacuity
  // tripwire that keeps the lane from silently disappearing.
  expect(
    existsSync(join(import.meta.dirname, 'presentation-mount.test.tsx')),
    'the presentation mount file must exist in this run',
  ).toBe(true);
  console.info(
    '[readiness] presentation mount lane: sibling file in this run; 0 coupling offenders',
  );
});

test('fixture: the canonical fixture is plain and its production build carries zero astroix bytes', () => {
  // plainness: no astroix dependency, import, or registration anywhere in
  // the tracked fixture. The fixture's own package NAME ("astroix-e2e-
  // fixture") is not injection — the checks are structural: source bytes,
  // config bytes, and the dependency graph stay astroix-free
  const plainnessOffenders: string[] = [];
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.astro') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) scan(full);
      else if (/\.(mjs|ts|astro|css|md)$/.test(entry)) {
        if (readFileSync(full, 'utf8').includes('astroix')) plainnessOffenders.push(full);
      }
    }
  };
  scan(join(FIXTURE, 'src'));
  for (const configFile of ['astro.config.mjs', 'tsconfig.json']) {
    if (readFileSync(join(FIXTURE, configFile), 'utf8').includes('astroix')) {
      plainnessOffenders.push(join(FIXTURE, configFile));
    }
  }
  expect(plainnessOffenders, 'the canonical fixture source must stay injection-free').toEqual([]);

  const fixtureManifest = JSON.parse(readFileSync(join(FIXTURE, 'package.json'), 'utf8')) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const depNames = [
    ...Object.keys(fixtureManifest.dependencies ?? {}),
    ...Object.keys(fixtureManifest.devDependencies ?? {}),
  ];
  expect(
    depNames.filter((name) => name.includes('astroix')),
    'the fixture manifest carries no astroix dependency',
  ).toEqual([]);
  expect(
    readFileSync(join(FIXTURE, 'package-lock.json'), 'utf8').includes('@wojciechpiskorz/astroix'),
    'the fixture lockfile resolves no astroix package',
  ).toBe(false);

  // the clean production build. PINNED COMPOSITION of
  // e2e/plain-build.spec.ts (the named no-product-E2E lane, deliberately
  // not imported): build, walk dist/, assert zero astroix bytes — the two
  // must move together.
  execSync('npm run build', { cwd: FIXTURE, stdio: 'pipe' });
  const dist = join(FIXTURE, 'dist');
  const files: string[] = [];
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) collect(full);
      else files.push(full);
    }
  };
  collect(dist);
  expect(files.length).toBeGreaterThan(0);
  const byteOffenders = files.filter((file) => readFileSync(file, 'utf8').includes('astroix'));
  expect(byteOffenders, 'no astroix bytes may appear in the fixture production output').toEqual([]);
  console.info(
    `[readiness] canonical fixture: plain, ${files.length} built files, zero astroix bytes`,
  );
}, 360_000);

test('counts: every unit, contract, and fixture lane is recorded and non-empty', () => {
  const ledger = assembleCountsLedger(); // throws on any empty lane
  for (const kind of ['unit', 'contract', 'fixture'] as const) {
    expect(
      ledger.rows.filter((row) => row.kind === kind).length,
      `at least one ${kind} lane is recorded`,
    ).toBeGreaterThan(0);
  }
  console.info(`[readiness] counts ledger (total ${ledger.total}):\n${formatCountsLedger(ledger)}`);
}, 180_000);

test('inventory: the evidence report names every deletion target and the gate actually deleted them', () => {
  const reconciliation = reconcileInventory(); // throws on drift or resurrection
  expect(reconciliation.targets).toBeGreaterThan(0);
  const gaps = inventoryGaps();
  console.info(
    `[readiness] inventory: ${reconciliation.targets} targets, ${reconciliation.a6OwnedCoverage} owned by #215, ${gaps.length} reconciliation gaps resolved by A6 (${gaps.map((gap) => gap.id).join(', ')})`,
  );
  // every gap must be carried in the report's reconciliation section
  const report = readFileSync(join('docs', 'retirement-readiness.md'), 'utf8');
  for (const gap of gaps) {
    expect(report, `the report must carry the ${gap.id} gap`).toContain(`target:${gap.id}`);
  }
});
