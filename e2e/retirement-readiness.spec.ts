import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { skipWithoutChromium } from './contract-oracle/live-capture.ts';
import { MAIN_PORT, withOracleServer } from './contract-oracle/oracle-server.ts';
import { validateContractFamilies } from './retirement-readiness/contracts.ts';
import { assembleCountsLedger, formatCountsLedger } from './retirement-readiness/counts.ts';
import { inventoryGaps, reconcileInventory } from './retirement-readiness/inventory.ts';
import { compareOracleEvidence } from './retirement-readiness/oracle-comparison.ts';

/**
 * The retirement-readiness suite (#214, lane A5, ADR-0010): the aggregate
 * proof that the plain canonical fixture, the frozen B1/B2 contracts, the
 * retained app-shell presentation, and the non-vacuous gate inventory
 * TOGETHER cover every behavior the legacy integration still held — the
 * deletion-eligibility proof A6 (#215) starts from. Six legs:
 *
 *   1. contracts (serverless)  — every family validates through its schema
 *      and re-derives through the RETAINED core, never legacy source.
 *   2. retained UI (serverless)— the presentation surface carries zero
 *      runtime couplings and its mount lane runs green over contract data.
 *   3. fixture (serverless)    — the canonical fixture is plain and its
 *      production build carries zero astroix bytes (AC-5).
 *   4. counts (serverless)    — every unit/contract/fixture lane is
 *      enumerated and non-empty (AC-4); the ledger is emitted for the
 *      evidence report.
 *   5. inventory (serverless) — the evidence report names every deletion
 *      target and reconciles with #215's owned paths (AC-6).
 *   6. oracle (@oracle-boot)  — one disposable-oracle boot comparing live
 *      evidence against the frozen contracts (AC-2: the oracle is used
 *      ONLY for this comparison; the canonical fixture itself stays plain).
 *
 * Proof only: this suite deletes nothing, changes no frozen corpus bytes,
 * and creates no replacement runtime.
 */

const FIXTURE = join('e2e', 'fixture');
const PRESENTATION_DIR = join('packages', 'app-shell', 'src', 'presentation');

test('contracts: every frozen family validates and re-derives through the retained core', () => {
  test.setTimeout(60_000);
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
  test.setTimeout(180_000);

  // (a) the coupling scan: the presentation surface's runtime modules carry
  // no /__astroix URL, no fetch, no browser transport, no Vite handle —
  // data and callbacks in, contract-shaped rendering out (AC-3).
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
  for (const entry of readdirSync(PRESENTATION_DIR)) {
    if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
    if (entry.includes('.test.') || testHelpers.has(entry)) continue;
    const text = readFileSync(join(PRESENTATION_DIR, entry), 'utf8');
    for (const { token, what } of forbidden) {
      if (text.includes(token)) offenders.push(`${entry}: ${what}`);
    }
  }
  expect(offenders, 'the presentation surface must stay runtime-uncoupled').toEqual([]);

  // (b) the mount lane: run the readiness presentation mounts (this
  // directory's own vitest lane) and require a green, NON-EMPTY run —
  // the widgets literally run against schema-validated contract data.
  const output = execSync('npx vitest run --config e2e/retirement-readiness/vitest.config.ts', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // strip vitest's ANSI color codes before parsing the summary (the ESC
  // byte is built at runtime — biome keeps control chars out of literals)
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const plain = output.replace(ansi, '');
  const passed = /Tests\s+(\d+)\s+passed/.exec(plain)?.[1];
  expect(
    passed,
    `the presentation mount lane must pass (output: ${plain.slice(-400)})`,
  ).toBeDefined();
  expect(Number(passed)).toBeGreaterThan(0);
  console.info(`[readiness] presentation mount lane: ${passed} tests green, 0 coupling offenders`);
});

test('fixture: the canonical fixture is plain and its production build carries zero astroix bytes', () => {
  test.setTimeout(240_000);

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

  // the clean production build (AC-5)
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
});

test('counts: every unit, contract, and fixture lane is recorded and non-empty', () => {
  test.setTimeout(180_000);
  const ledger = assembleCountsLedger(); // throws on any empty lane
  for (const kind of ['unit', 'contract', 'fixture'] as const) {
    expect(
      ledger.rows.filter((row) => row.kind === kind).length,
      `at least one ${kind} lane is recorded`,
    ).toBeGreaterThan(0);
  }
  console.info(`[readiness] counts ledger (total ${ledger.total}):\n${formatCountsLedger(ledger)}`);
});

test('inventory: the evidence report names every deletion target and reconciles with A6', () => {
  const reconciliation = reconcileInventory(); // throws on drift
  expect(reconciliation.targets).toBeGreaterThan(0);
  const gaps = inventoryGaps();
  console.info(
    `[readiness] inventory: ${reconciliation.targets} targets, ${reconciliation.a6OwnedCoverage} owned by #215, ${gaps.length} reconciliation gaps (${gaps.map((gap) => gap.id).join(', ')})`,
  );
  // every gap must be carried in the report's reconciliation section
  const report = readFileSync(join('docs', 'retirement-readiness.md'), 'utf8');
  for (const gap of gaps) {
    expect(report, `the report must carry the ${gap.id} gap`).toContain(`target:${gap.id}`);
  }
});

test('oracle: a live disposable oracle still matches the frozen contracts', {
  tag: '@oracle-boot',
}, async () => {
  skipWithoutChromium();
  test.setTimeout(240_000);
  await withOracleServer('main', MAIN_PORT, async (handle) => {
    // a real document load first — and the browser STAYS OPEN through the
    // comparison: the scoped style module enters the client module graph
    // only once a browser fetches it, and the join the index payload
    // serves is tied to that live graph (B1's seam)
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(handle.base, { waitUntil: 'load' });
      const rows = await compareOracleEvidence(handle);
      for (const row of rows) {
        expect(row.held, `oracle comparison: ${row.what}`).toBe(true);
      }
      console.info('[readiness] oracle comparison rows held:', rows.map((row) => row.what).length);
      await page.close();
    } finally {
      await browser.close();
    }
  });
});
