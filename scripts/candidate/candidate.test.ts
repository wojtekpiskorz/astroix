/**
 * The candidate workflow's own focused self-tests (#259, L2 — the
 * ticket's "focused tests" list): every fail-closed mode is proven RED
 * here, deterministically and network-free. The heavyweight truths —
 * the one real build, the real draft upload/download, the real matrix
 * — are the dispatch workflow's and the local dry run's; what these
 * tests pin is that every failure mode FAILS when it must:
 *
 *   - the checksum law: local-build, uploaded, and downloaded
 *     checksums must match (rebuilt bytes fail)
 *   - pin drift fails the candidate, per field
 *   - dirty source fails the candidate
 *   - the better-sqlite3 fixture executes only under the bundled Node:
 *     wrong version, ABI, OS, or architecture each reject before the
 *     addon is ever loaded; a missing build rejects as not-loaded
 *   - the node-sass negative fixture rejects prelaunch,
 *     deterministically, with all six diagnostic fields, and never
 *     installs (no node_modules can appear)
 *   - the evidence manifest fails closed: missing evidence, a
 *     checksum drift, a macOS-13.5 claim without an exact 13.5 host,
 *     a skipped matrix leg, an unexecuted fixture, a non-restricted
 *     draft reference
 *   - the workflow file obeys its own law: dispatch-only triggers,
 *     draft-only release steps, no publish, evidence artifacts
 *
 * Run with `npm run test:candidate` (node --test over the loader
 * idiom, like the candidate CLI itself).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyBuildAttestation } from './build-attestation.ts';
import { verifyTransfer } from './checksum.ts';
import { checkDraftRef, draftAssetRef, modeCombinationProblem } from './draft-release.ts';
import { readSourceFacts } from './git-state.ts';
import { macOsClaim } from './host-facts.ts';
import { MATRIX_LEGS, type ManifestDraft, validateManifest } from './manifest.ts';
import { CHARTER_PINS, reconcilePins } from './pins.ts';
import { type BootFacts, leaseFindings } from './registry-lease.ts';
import { validateWorkflow, validateWorkflowFile, WORKFLOW_PATH } from './workflow-law.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const FIXTURES = join(ROOT, 'qualification', 'fixtures');

// ——— the checksum law (#259: local-build, uploaded, downloaded must match) ———

test('the checksum law: expected/assembled/received all agreeing is the only green shape', () => {
  const sha = 'a'.repeat(64);
  assert.equal(verifyTransfer({ expected: sha, assembled: sha, received: sha }).ok, true);
});

test('the checksum law: rebuilt assembled bytes fail as rebuilt-bytes', () => {
  const verdict = verifyTransfer({
    expected: 'a'.repeat(64),
    assembled: 'b'.repeat(64),
    received: 'a'.repeat(64),
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failure?.code, 'rebuilt-bytes');
});

test('the checksum law: different received bytes fail as a checksum mismatch', () => {
  const verdict = verifyTransfer({
    expected: 'a'.repeat(64),
    assembled: 'a'.repeat(64),
    received: 'c'.repeat(64),
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failure?.code, 'checksum-mismatch-assembled');
});

// ——— pin drift ———

const CHARTER_REPO = {
  node: CHARTER_PINS.node,
  electron: CHARTER_PINS.electron,
  forge: CHARTER_PINS.forge,
  pair: CHARTER_PINS.pair,
  minimumMacOS: CHARTER_PINS.minimumMacOS,
};

test('pin reconciliation: the charter itself is green against an equal repo table', () => {
  assert.deepEqual(reconcilePins(CHARTER_PINS, CHARTER_REPO), []);
});

test('pin drift: every drifted field fails by name (a drift is a STOP, never a substitution)', () => {
  const drifts: Array<[keyof typeof CHARTER_REPO, string]> = [
    ['node', 'v24.19.0'],
    ['electron', '44.2.0'],
    ['forge', '7.12.0'],
    ['minimumMacOS', '14.0'],
  ];
  for (const [field, declared] of drifts) {
    const repo = { ...CHARTER_REPO, [field]: declared };
    const findings = reconcilePins(CHARTER_PINS, repo);
    assert.equal(findings.length, 1, `${String(field)} drift must fail`);
    assert.equal(findings[0]?.field, field);
    assert.equal(findings[0]?.declared, declared);
  }
  const pairAstro = { ...CHARTER_REPO, pair: { ...CHARTER_PINS.pair, astro: '7.2.11' } };
  assert.equal(reconcilePins(CHARTER_PINS, pairAstro)[0]?.field, 'pair.astro');
  const pairVite = { ...CHARTER_REPO, pair: { ...CHARTER_PINS.pair, vite: '8.2.3' } };
  assert.equal(reconcilePins(CHARTER_PINS, pairVite)[0]?.field, 'pair.vite');
});

test('pin reconciliation: the live repo pin tables reconcile against the charter (the reconciliation this lane owes)', async () => {
  const { readRepoPins } = await import('./repo-pins.ts');
  const repo = await readRepoPins();
  assert.deepEqual(reconcilePins(CHARTER_PINS, repo), []);
});

// ——— dirty source ———

test('dirty source: a non-empty porcelain view fails the clean-source law', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'astroix-candidate-selftest-'));
  try {
    const git = (args: string[]) => spawnSync('git', args, { cwd: scratch, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 'selftest@example.invalid']);
    git(['config', 'user.name', 'selftest']);
    await writeFile(join(scratch, 'tracked.txt'), 'one\n');
    git(['add', 'tracked.txt']);
    git(['commit', '-q', '-m', 'one']);
    const clean = await readSourceFacts(scratch);
    assert.equal(clean.clean, true);
    await writeFile(join(scratch, 'tracked.txt'), 'two\n');
    const dirty = await readSourceFacts(scratch);
    assert.equal(dirty.clean, false);
    assert.equal(dirty.porcelain.length, 1);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ——— the better-sqlite3 fixture guard (executes only under the bundled Node) ———

/**
 * Runs the fixture guard under THIS process's node with the given
 * expectations — every mismatch direction is deterministic because the
 * guard compares the flags against the running process's own facts.
 */
function runGuard(expectations: { node?: string; abi?: string; os?: string; arch?: string }): {
  status: number | null;
  stdout: string;
} {
  // the unspecified expectations default to THIS runtime's own facts, so
  // exactly the field under test mismatches — the one-law-at-a-time
  // shape (against the bundled runtime itself the defaults are the
  // charter's, and every test would collapse into the version test)
  const full = {
    node: process.version,
    abi: process.versions.modules ?? '',
    os: process.platform,
    arch: process.arch,
    ...expectations,
  };
  const argv = [
    join(FIXTURES, 'native-better-sqlite3', 'check.mjs'),
    '--expect-node',
    full.node,
    '--expect-abi',
    full.abi,
    '--expect-os',
    full.os,
    '--expect-arch',
    full.arch,
  ];
  const run = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 30_000 });
  return { status: run.status, stdout: run.stdout };
}

test('the native fixture: a wrong expected Node version rejects coded, before the addon loads', () => {
  const run = runGuard({ node: 'v24.19.0' });
  assert.notEqual(run.status, 0);
  const verdict = JSON.parse(run.stdout) as { rejected: boolean; code: string };
  assert.equal(verdict.rejected, true);
  assert.equal(verdict.code, 'wrong-node');
});

test('the native fixture: a wrong expected ABI rejects coded', () => {
  const run = runGuard({ abi: '136' });
  assert.notEqual(run.status, 0);
  assert.equal((JSON.parse(run.stdout) as { code: string }).code, 'wrong-abi');
});

test('the native fixture: a wrong expected OS rejects coded', () => {
  const run = runGuard({ os: process.platform === 'darwin' ? 'linux' : 'darwin' });
  assert.notEqual(run.status, 0);
  assert.equal((JSON.parse(run.stdout) as { code: string }).code, 'wrong-os');
});

test('the native fixture: a wrong expected architecture rejects coded', () => {
  const run = runGuard({ arch: process.arch === 'arm64' ? 'x64' : 'arm64' });
  assert.notEqual(run.status, 0);
  assert.equal((JSON.parse(run.stdout) as { code: string }).code, 'wrong-arch');
});

test('the native fixture: matching expectations but no built addon rejects as not-loaded (the guard never fabricates execution)', () => {
  // the identity expectations match THIS runtime, so the guard passes the
  // identity law and dies at the only law it can honestly fail here:
  // loading the addon that was never built beside the template
  const run = runGuard({
    node: process.version,
    abi: process.versions.modules ?? '',
    os: process.platform,
    arch: process.arch,
  });
  assert.notEqual(run.status, 0);
  const verdict = JSON.parse(run.stdout) as { code: string };
  assert.equal(verdict.code, 'addon-not-loaded');
});

// ——— the node-sass fixture (prelaunch deterministic rejection, never installed) ———

function runSass(runtime: { node: string; abi: string; os: string; arch: string }): {
  status: number | null;
  stdout: string;
} {
  const run = spawnSync(
    process.execPath,
    [
      join(FIXTURES, 'unsupported-node-sass', 'reject.mjs'),
      '--manifest',
      join(FIXTURES, 'unsupported-node-sass', 'package.json'),
      '--runtime-node',
      runtime.node,
      '--runtime-abi',
      runtime.abi,
      '--os',
      runtime.os,
      '--arch',
      runtime.arch,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  return { status: run.status, stdout: run.stdout };
}

test('the node-sass fixture: the charter runtime rejects node-sass 9 prelaunch with the six structured fields', () => {
  const run = runSass({
    node: CHARTER_PINS.node,
    abi: CHARTER_PINS.nodeAbi,
    os: 'darwin',
    arch: 'arm64',
  });
  assert.equal(run.status, 0);
  const verdict = JSON.parse(run.stdout) as {
    accepted: boolean;
    installed: boolean;
    phase: string;
    rejection: Record<string, unknown>;
  };
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.installed, false);
  assert.equal(verdict.phase, 'prelaunch');
  for (const field of ['package', 'version', 'runtime', 'os', 'architecture', 'upstream-support']) {
    assert.notEqual(verdict.rejection[field], undefined, `the diagnostic is missing ${field}`);
  }
  assert.equal(verdict.rejection.package, 'node-sass');
  assert.equal(verdict.rejection.version, '9.0.0');
  assert.deepEqual(verdict.rejection.runtime, { node: 'v24.20.0', abi: '137' });
  assert.equal(verdict.rejection.os, 'darwin');
  assert.equal(verdict.rejection.architecture, 'arm64');
});

test('the node-sass fixture: the rejection is deterministic (two screenings are byte-identical)', () => {
  const runtime = {
    node: CHARTER_PINS.node,
    abi: CHARTER_PINS.nodeAbi,
    os: 'darwin',
    arch: 'arm64',
  };
  assert.equal(runSass(runtime).stdout, runSass(runtime).stdout);
});

test('the node-sass fixture: never installs — no node_modules can appear beside it', async () => {
  const dir = join(FIXTURES, 'unsupported-node-sass');
  runSass({ node: CHARTER_PINS.node, abi: CHARTER_PINS.nodeAbi, os: 'darwin', arch: 'arm64' });
  const entries = await readdir(dir);
  assert.deepEqual(
    entries.filter((entry) => entry !== 'package.json' && entry !== 'reject.mjs'),
    [],
    'the fixture directory must hold only its manifest and its screener',
  );
  assert.equal(existsSync(join(dir, 'node_modules')), false);
});

test('the node-sass fixture: a manifest without node-sass is accepted (the screener is not vacuously rejecting)', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'astroix-sass-selftest-'));
  try {
    await writeFile(
      join(scratch, 'package.json'),
      JSON.stringify({ name: 'plain', dependencies: { sass: '1.0.0' } }),
    );
    const run = spawnSync(
      process.execPath,
      [
        join(FIXTURES, 'unsupported-node-sass', 'reject.mjs'),
        '--manifest',
        join(scratch, 'package.json'),
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(run.status, 0);
    assert.equal((JSON.parse(run.stdout) as { accepted: boolean }).accepted, true);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('the node-sass fixture: a runtime upstream DOES support (node 20) is not rejected — the table, not a blanket rule, decides', () => {
  const run = runSass({ node: 'v20.18.0', abi: '115', os: 'darwin', arch: 'arm64' });
  assert.equal(run.status, 0);
  assert.equal((JSON.parse(run.stdout) as { accepted: boolean }).accepted, true);
});

// ——— the registry-lease shaping (unsupported storage + every bad shape) ———

function bootFacts(overrides: Partial<BootFacts>): BootFacts {
  return {
    boot: 1,
    booted: true,
    exitedEarly: null,
    lease: { present: true, regularFile: true, fileMode: '600', directoryMode: '700' },
    quitOutcome: 'exited-on-own-quit-surface',
    ...overrides,
  };
}

test('registry-lease: the green shape is green', () => {
  const shaped = leaseFindings({
    firstBoot: bootFacts({ boot: 1 }),
    secondBoot: bootFacts({ boot: 2 }),
    residuals: [],
  });
  assert.deepEqual(shaped.findings, []);
  assert.equal(shaped.ok, true);
});

test('registry-lease: a booted app with no lease file is unsupported storage (RED)', () => {
  const noLease = { present: false, regularFile: false, fileMode: null, directoryMode: null };
  const shaped = leaseFindings({
    firstBoot: bootFacts({ lease: noLease }),
    secondBoot: bootFacts({ boot: 2, lease: noLease }),
    residuals: [],
  });
  assert.equal(shaped.ok, false);
  assert.equal(shaped.storageUnsupported, true);
  assert.equal(
    shaped.findings.some((finding) => finding.includes('unsupported storage')),
    true,
  );
});

test('registry-lease: wrong modes, a missing boot, an unsettled quit, and residuals each fail by name', () => {
  assert.equal(
    leaseFindings({
      firstBoot: bootFacts({
        lease: { present: true, regularFile: true, fileMode: '644', directoryMode: '700' },
      }),
      secondBoot: bootFacts({ boot: 2 }),
      residuals: [],
    }).ok,
    false,
  );
  assert.equal(
    leaseFindings({
      firstBoot: bootFacts({
        lease: { present: true, regularFile: true, fileMode: '600', directoryMode: '755' },
      }),
      secondBoot: bootFacts({ boot: 2 }),
      residuals: [],
    }).ok,
    false,
  );
  assert.equal(
    leaseFindings({
      firstBoot: bootFacts({ booted: false }),
      secondBoot: bootFacts({ boot: 2 }),
      residuals: [],
    }).ok,
    false,
  );
  assert.equal(
    leaseFindings({
      firstBoot: bootFacts({ quitOutcome: 'forced' }),
      secondBoot: bootFacts({ boot: 2 }),
      residuals: [],
    }).ok,
    false,
  );
  assert.equal(
    leaseFindings({
      firstBoot: bootFacts({}),
      secondBoot: bootFacts({ boot: 2 }),
      residuals: [{ pid: '1', command: 'stray' }],
    }).ok,
    false,
  );
  // the second boot is the release proof: it failing is a failure of the
  // release law even when the first boot was perfect
  assert.equal(
    leaseFindings({
      firstBoot: bootFacts({}),
      secondBoot: bootFacts({ boot: 2, booted: false }),
      residuals: [],
    }).ok,
    false,
  );
});

// ——— the macOS-13.5 honesty law ———

test('macOS disclosure: a non-13.5 host verifies 13.5 as metadata only, with the real facts disclosed', () => {
  const claim = macOsClaim(
    {
      platform: 'darwin',
      arch: 'arm64',
      swVersProduct: '26.3.1',
      swVersBuild: '25D771280a',
      unameMachine: 'arm64',
      harnessNodeVersion: process.version,
    },
    '13.5',
  );
  assert.equal(claim.verifiedAs, 'metadata-only');
  assert.equal(claim.controlledMinimumHost, false);
  assert.equal(claim.disclosure.includes('26.3.1'), true);
  assert.equal(claim.disclosure.includes('25D771280a'), true);
  assert.equal(claim.disclosure.includes('13.5'), true);
});

test('macOS disclosure: only an exact 13.5 host earns the host-verified claim', () => {
  const exact = macOsClaim(
    {
      platform: 'darwin',
      arch: 'arm64',
      swVersProduct: '13.5',
      swVersBuild: '22G74',
      unameMachine: 'arm64',
      harnessNodeVersion: process.version,
    },
    '13.5',
  );
  assert.equal(exact.verifiedAs, 'host');
  assert.equal(exact.controlledMinimumHost, true);
});

// ——— the evidence-manifest completeness law ———

/** A complete green manifest — the shape every RED mutation starts from (top-level mutable: the mutations replace whole sections). */
function greenManifest(): ManifestDraft {
  const sha = 'a'.repeat(64);
  const draft = draftAssetRef({ label: 'selftest', assetName: 'Astroix-darwin-arm64-0.1.0.zip' });
  return {
    schema: 1,
    workflow: 'astroix-pre-alpha-candidate',
    lane: 'L2 restricted candidate workflow (#259)',
    label: 'selftest',
    mode: 'dry-run',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    source: { commit: 'b'.repeat(40), clean: true, porcelain: [] },
    pins: {
      charter: {
        node: 'v24.20.0',
        nodeAbi: '137',
        electron: '44.1.0',
        forge: '7.11.2',
        pair: { astro: '7.2.10', vite: '8.2.2' },
        minimumMacOS: '13.5',
      },
      repo: {
        node: 'v24.20.0',
        electron: '44.1.0',
        forge: '7.11.2',
        pair: { astro: '7.2.10', vite: '8.2.2' },
        minimumMacOS: '13.5',
      },
      reconciled: true,
      findings: [],
    },
    build: {
      command: 'npm run package',
      zip: { path: '/tmp/x.zip', bytes: 168671476, sha256: sha },
      builtOnce: true,
    },
    transfer: {
      mode: 'dry-run',
      checksumBefore: sha,
      checksumAfter: sha,
      match: true,
      uploaded: false,
      downloaded: false,
      draftAsset: {
        repository: draft.repository,
        tag: draft.tag,
        asset: draft.asset,
        url: draft.url,
        visibility: 'restricted-draft',
      },
    },
    host: {
      platform: 'darwin',
      arch: 'arm64',
      swVersProduct: '26.3.1',
      swVersBuild: '25D771280a',
      unameMachine: 'arm64',
      harnessNodeVersion: 'v24.20.0',
    },
    minimumMacOS: {
      metadata: '13.5',
      verifiedAs: 'metadata-only',
      testedOn: { swVersProduct: '26.3.1', swVersBuild: '25D771280a', unameMachine: 'arm64' },
      controlledMinimumHost: false,
      disclosure:
        'verified as PACKAGE METADATA ONLY; actually ran on sw_vers 26.3.1 build 25D771280a, arm64',
    },
    matrix: MATRIX_LEGS.map((leg) => ({
      leg,
      status: 'passed' as const,
      summary: 'green',
      exitCode: 0,
      logFile: `logs/${leg}.log`,
    })),
    fixtures: {
      betterSqlite3: {
        executed: true,
        packageVersion: '12.10.0',
        runtime: { node: 'v24.20.0', abi: '137' },
        builtFromSource: true,
        builtUnder: 'v24.20.0',
        inMemory: { created: true, inserted: 2, selected: 2, closed: true },
        detail: null,
      },
      nodeSass: {
        rejected: true,
        installed: false,
        diagnostic: {
          package: 'node-sass',
          version: '9.0.0',
          runtime: { node: 'v24.20.0', abi: '137' },
          os: 'darwin',
          architecture: 'arm64',
          'upstream-support': { status: 'deprecated' },
        },
      },
    },
    verdict: { ok: true, failures: [] },
  };
}

test('manifest completeness: the green shape is green', () => {
  assert.deepEqual(validateManifest(greenManifest(), '13.5').problems, []);
});

test('manifest completeness: missing evidence fails by name (each RED mode)', () => {
  const cases: Array<[string, (manifest: ManifestDraft) => void]> = [
    [
      'dirty source',
      (manifest) => {
        manifest.source = { commit: 'b'.repeat(40), clean: false, porcelain: [' M src/x.ts'] };
      },
    ],
    [
      'pin drift',
      (manifest) => {
        manifest.pins = { ...manifest.pins, reconciled: false, findings: [{ field: 'node' }] };
      },
    ],
    [
      'rebuilt bytes',
      (manifest) => {
        manifest.transfer = { ...manifest.transfer, checksumAfter: 'c'.repeat(64), match: false };
      },
    ],
    [
      'checksum-before is not the build checksum',
      (manifest) => {
        manifest.transfer = { ...manifest.transfer, checksumBefore: 'd'.repeat(64) };
      },
    ],
    [
      'a dry run that claims an upload',
      (manifest) => {
        manifest.transfer = { ...manifest.transfer, uploaded: true };
      },
    ],
    [
      'a non-restricted draft reference',
      (manifest) => {
        manifest.transfer = {
          ...manifest.transfer,
          draftAsset: { ...manifest.transfer.draftAsset, visibility: 'public' },
        };
      },
    ],
    [
      'a macOS 13.5 host claim without a 13.5 host',
      (manifest) => {
        manifest.minimumMacOS = {
          ...manifest.minimumMacOS,
          verifiedAs: 'host',
          controlledMinimumHost: true,
        };
      },
    ],
    [
      'a disclosure that hides the tested build',
      (manifest) => {
        manifest.minimumMacOS = { ...manifest.minimumMacOS, disclosure: 'tested somewhere' };
      },
    ],
    [
      'a skipped matrix leg',
      (manifest) => {
        manifest.matrix = manifest.matrix.map((leg) =>
          leg.leg === 'web-checkpoint'
            ? { ...leg, status: 'failed', summary: 'SKIPPED — nope' }
            : leg,
        );
      },
    ],
    [
      'a missing matrix leg',
      (manifest) => {
        manifest.matrix = manifest.matrix.filter((leg) => leg.leg !== 'registry-lease');
      },
    ],
    [
      'an unexecuted native fixture',
      (manifest) => {
        manifest.fixtures = {
          ...manifest.fixtures,
          betterSqlite3: { ...manifest.fixtures.betterSqlite3, executed: false, detail: 'nope' },
        };
      },
    ],
    [
      'an incomplete in-memory sequence',
      (manifest) => {
        manifest.fixtures = {
          ...manifest.fixtures,
          betterSqlite3: {
            ...manifest.fixtures.betterSqlite3,
            inMemory: { created: true, inserted: 0, selected: 0, closed: false },
          },
        };
      },
    ],
    [
      'an unrejected node-sass',
      (manifest) => {
        manifest.fixtures = {
          ...manifest.fixtures,
          nodeSass: { rejected: false, installed: false, diagnostic: null },
        };
      },
    ],
    [
      'an installed node-sass',
      (manifest) => {
        manifest.fixtures = {
          ...manifest.fixtures,
          nodeSass: { ...manifest.fixtures.nodeSass, installed: true },
        };
      },
    ],
    [
      'a diagnostic missing fields',
      (manifest) => {
        manifest.fixtures = {
          ...manifest.fixtures,
          nodeSass: { rejected: true, installed: false, diagnostic: { package: 'node-sass' } },
        };
      },
    ],
    [
      'an unsealed verdict',
      (manifest) => {
        manifest.verdict = null;
      },
    ],
    [
      'a minimum-OS metadata drift',
      (manifest) => {
        manifest.minimumMacOS = { ...manifest.minimumMacOS, metadata: '14.0' };
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const manifest = greenManifest();
    mutate(manifest);
    const verdict = validateManifest(manifest, '13.5');
    assert.equal(verdict.ok, false, `${name} must fail the manifest`);
    assert.notEqual(verdict.problems.length, 0, `${name} must name its problem`);
  }
});

test('manifest completeness: the downloaded mode demands both upload and download records', () => {
  const manifest = greenManifest();
  manifest.mode = 'downloaded';
  manifest.transfer = {
    ...manifest.transfer,
    mode: 'downloaded',
    uploaded: false,
    downloaded: false,
  };
  assert.equal(validateManifest(manifest, '13.5').ok, false);
  manifest.transfer = { ...manifest.transfer, uploaded: true, downloaded: true };
  assert.equal(validateManifest(manifest, '13.5').ok, true);
});

// ——— the draft reference law ———

test('the draft reference: the dry-run shape is deterministic in the label, and mismatches refuse', () => {
  const draft = draftAssetRef({ label: 'dry-run-259', assetName: 'Astix.zip' });
  assert.equal(draft.tag, 'pre-alpha-candidate-dry-run-259');
  assert.equal(
    draft.url,
    'https://github.com/wojtekpiskorz/astroix/releases/download/pre-alpha-candidate-dry-run-259/Astix.zip',
  );
  assert.equal(
    checkDraftRef({ repository: draft.repository, tag: draft.tag, asset: draft.asset }, draft),
    null,
  );
  assert.equal(
    checkDraftRef({ repository: 'someone/else', tag: draft.tag, asset: draft.asset }, draft),
    'wrong-repository',
  );
  assert.equal(
    checkDraftRef({ repository: draft.repository, tag: 'other-tag', asset: draft.asset }, draft),
    'wrong-tag',
  );
  assert.equal(
    checkDraftRef(
      { repository: draft.repository, tag: draft.tag, asset: draft.asset, visibility: 'public' },
      draft,
    ),
    'wrong-visibility',
  );
  assert.equal(checkDraftRef({ repository: '', tag: '', asset: '' }, draft), 'malformed');
});

test('the draft reference: a wrong asset name refuses as wrong-asset (the upload must land on the SAME asset)', () => {
  const draft = draftAssetRef({
    label: 'dry-run-259',
    assetName: 'Astroix-darwin-arm64-0.1.0.zip',
  });
  assert.equal(
    checkDraftRef(
      {
        repository: draft.repository,
        tag: draft.tag,
        asset: 'Astroix-darwin-arm64-0.2.0.zip',
      },
      draft,
    ),
    'wrong-asset',
  );
});

// ——— the mode law over the reference (#259 review round 6: downloaded
// ——— mode requires it; dry-run keeps it optional and prospective) ———

test('the mode law: downloaded mode without --draft-ref refuses by name — the reference is retrospective there, never silent', () => {
  // the leaseFindings idiom: a direct unit call against the pure law,
  // host-independent (the CLI self-executes at import, so the law is
  // exported from draft-release.ts, beside the reference it governs)
  assert.equal(
    modeCombinationProblem('downloaded', true, true, undefined),
    'downloaded mode requires --draft-ref — in the one mode where the reference is retrospective and cross-checkable, its absence is a refusal, never silent',
  );
  // dry-run keeps the reference optional and prospective — absent or supplied
  assert.equal(modeCombinationProblem('dry-run', false, false, undefined), null);
  assert.equal(
    modeCombinationProblem(
      'dry-run',
      false,
      false,
      'wojtekpiskorz/astroix:pre-alpha-candidate-x:a.zip',
    ),
    null,
  );
  // the transfer-flags law it joined still holds, by name
  assert.equal(
    modeCombinationProblem(
      'downloaded',
      false,
      false,
      'wojtekpiskorz/astroix:pre-alpha-candidate-x:a.zip',
    ),
    'downloaded mode requires both --uploaded and --downloaded',
  );
  assert.equal(
    modeCombinationProblem('dry-run', true, false, undefined),
    'a dry run records no upload and no download',
  );
});

// ——— the one-build attestation law (#259 review round 1: builtOnce
// ——— records only what the recorder observed or verified) ———

test('the build attestation: a named build manifest recording the received checksum is the only green shape', () => {
  const sha = 'a'.repeat(64);
  const manifest = { zip: { file: 'Astroix-darwin-arm64-0.1.0.zip', sha256: sha } };
  assert.equal(verifyBuildAttestation({ buildManifest: manifest, receivedSha256: sha }), null);
});

test('the build attestation: a named build manifest recording different bytes refuses as wrong-checksum', () => {
  const sha = 'a'.repeat(64);
  const manifest = { zip: { file: 'Astroix-darwin-arm64-0.1.0.zip', sha256: sha } };
  assert.equal(
    verifyBuildAttestation({ buildManifest: manifest, receivedSha256: 'b'.repeat(64) }),
    'wrong-checksum',
  );
});

test('the build attestation: anything that is not a build manifest refuses as malformed-manifest', () => {
  const sha = 'a'.repeat(64);
  const brokenShapes: unknown[] = [
    null,
    {},
    { zip: {} },
    { zip: { file: '', sha256: sha } },
    { zip: { file: 'Astroix.zip', sha256: 'not-hex' } },
  ];
  for (const broken of brokenShapes) {
    assert.equal(
      verifyBuildAttestation({ buildManifest: broken, receivedSha256: sha }),
      'malformed-manifest',
    );
  }
});

// ——— the workflow law ———

/** The workflow shape the law judges — loose on purpose: the mutations replace whole sections. */
type LooseWorkflow = {
  name: string;
  on: Record<string, unknown>;
  jobs: Record<string, Record<string, unknown>>;
};
const WORKFLOW_BASE: LooseWorkflow = {
  name: 'Pre-alpha candidate',
  on: { workflow_dispatch: { inputs: {} } },
  jobs: {
    candidate: {
      'runs-on': 'macos-15',
      'timeout-minutes': 150,
      steps: [
        { run: 'npm run candidate -- preflight' },
        { uses: 'actions/upload-artifact@v4', with: { path: 'qualification/manifests/' } },
      ],
    },
  },
};

test('the workflow law: the base shape is green', () => {
  assert.deepEqual(validateWorkflow(structuredClone(WORKFLOW_BASE) as LooseWorkflow).problems, []);
});

test('the workflow law: per-PR or per-push triggers refuse (dispatch only)', () => {
  const push = structuredClone(WORKFLOW_BASE) as LooseWorkflow;
  push.on = { push: { branches: ['main'] }, workflow_dispatch: { inputs: {} } };
  assert.equal(validateWorkflow(push).ok, false);
  const pr = structuredClone(WORKFLOW_BASE) as LooseWorkflow;
  pr.on = { pull_request: null, workflow_dispatch: { inputs: {} } };
  assert.equal(validateWorkflow(pr).ok, false);
  const scheduled = structuredClone(WORKFLOW_BASE) as LooseWorkflow;
  scheduled.on = { schedule: [{ cron: '0 0 * * *' }] };
  assert.equal(validateWorkflow(scheduled).ok, false);
});

/** One base-shape clone with a mutation applied to its single job's shape. */
function mutatedJob(
  mutate: (job: {
    'runs-on'?: string;
    'timeout-minutes'?: number;
    steps: Array<{ run: string }>;
  }) => void,
): LooseWorkflow {
  const doc = structuredClone(WORKFLOW_BASE) as LooseWorkflow;
  const job = doc.jobs.candidate as NonNullable<LooseWorkflow['jobs']['candidate']> as {
    'runs-on'?: string;
    'timeout-minutes'?: number;
    steps: Array<{ run: string }>;
  };
  mutate(job);
  return doc;
}

test('the workflow law: a non-draft release, a publish step, a missing timeout, and a non-macOS runner each refuse', () => {
  assert.equal(
    validateWorkflow(
      mutatedJob((job) => job.steps.push({ run: 'gh release create v1 app.zip --title x' })),
    ).ok,
    false,
  );
  assert.equal(
    validateWorkflow(mutatedJob((job) => job.steps.push({ run: 'npm publish' }))).ok,
    false,
  );
  assert.equal(
    validateWorkflow(
      mutatedJob((job) => job.steps.push({ run: 'gh release edit v1 --draft=false' })),
    ).ok,
    false,
  );
  assert.equal(validateWorkflow(mutatedJob((job) => delete job['timeout-minutes'])).ok, false);
  assert.equal(validateWorkflow(mutatedJob((job) => (job['runs-on'] = 'ubuntu-latest'))).ok, false);
  assert.equal(
    validateWorkflow(mutatedJob((job) => (job.steps = [{ run: 'npm run candidate -- preflight' }])))
      .ok,
    false,
  );
});

test('the workflow law: the LIVE workflow file obeys its own law', async () => {
  const verdict = await validateWorkflowFile(WORKFLOW_PATH);
  assert.deepEqual(verdict.problems, []);
});

test('the workflow law: the live file carries the checksum-before/checksum-after discipline and the draft-only upload', async () => {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(WORKFLOW_PATH, 'utf8');
  assert.equal(text.includes('gh release create'), true);
  assert.equal(text.includes('--draft'), true);
  assert.equal(text.includes('checksum-after'), true);
  assert.equal(/checksum-before/.test(text), true);
  assert.equal(/gh release download/.test(text), true);
  // every qualify step attests the one build it qualifies (#259 review
  // round 1: a standalone recorder observed no build of its own)
  assert.equal(text.includes('--built'), true);
});

// ——— the CLI's own refusal laws, driven live (#259 review round 1) ———
// The L1 cli-arguments idiom: spawn the REAL CLI over the raw-Node
// loader. The label-law leg runs everywhere (the argument parser's
// refusal precedes the CLI's platform guard); the qualify-gate legs
// need the gates the platform guard fronts, so they self-skip off the
// candidate host shape and run for real on the candidate lane's macOS
// arm64 hosts (ADR-0008).

const CANDIDATE_CLI = join(HERE, 'cli.ts');
const NODE_FLAGS = [
  '--experimental-transform-types',
  '--import',
  './apps/desktop/raw-node-register.mjs',
];
const ON_CANDIDATE_HOST = process.platform === 'darwin' && process.arch === 'arm64';
const CLI_HOST_SKIP = ON_CANDIDATE_HOST
  ? false
  : 'the candidate CLI admits macOS arm64 hosts only (ADR-0008) — its platform guard fires first';

function runCandidateCli(args: readonly string[]): { status: number | null; stderr: string } {
  const run = spawnSync(process.execPath, [...NODE_FLAGS, CANDIDATE_CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: run.status, stderr: run.stderr };
}

test('the label law: a label outside the closed charset is refused before anything derives a path from it', () => {
  for (const label of ['../escape', 'nested/../path', 'Upper', 'with space', '.hidden', 'a:b']) {
    const run = runCandidateCli([
      'qualify',
      '--label',
      label,
      '--zip',
      '/tmp/absent.zip',
      '--expected-sha256',
      'a'.repeat(64),
    ]);
    assert.equal(run.status, 2, JSON.stringify(label));
    assert.match(run.stderr, /--label must be lower-case letters, digits, and dashes/);
  }
  // The parser's own refusal law (#259 review round 5): a typo'd flag is
  // refused by name (never silently swallowed — `--draftt-ref` would skip
  // the wrong-asset cross-check) and a flag given twice is a rejection.
  // Parse refusals precede the platform guard, so these legs run on every host.
  const typo = runCandidateCli([
    'qualify',
    '--label',
    'probe',
    '--draftt-ref',
    'wojtekpiskorz/astroix:t:a.zip',
  ]);
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /--draftt-ref is not a qualify flag/);
  const duplicate = runCandidateCli(['build', '--label', 'a', '--label', 'b']);
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /--label given twice/);
});

/**
 * A scratch evidence layout: a prior manifest that must survive every
 * refusal, a received ZIP, and a matching `--built` attestation (the
 * packaging-manifest shape, recording the same checksum the run is
 * held to).
 */
async function stageScratchEvidence(): Promise<{
  scratch: string;
  manifestDir: string;
  priorManifest: Buffer;
  zipPath: string;
  builtPath: string;
}> {
  const sha = 'e'.repeat(64);
  const scratch = await mkdtemp(join(tmpdir(), 'astroix-candidate-evidence-'));
  const manifestDir = join(scratch, 'evidence');
  await mkdir(manifestDir, { recursive: true });
  const priorManifest = Buffer.from('{ "schema": 1, "label": "prior", "verdict": "sealed" }\n');
  await writeFile(join(manifestDir, 'manifest.json'), priorManifest);
  const zipPath = join(scratch, 'Astroix-darwin-arm64-0.1.0.zip');
  await writeFile(zipPath, 'received bytes');
  const builtPath = join(scratch, 'build-manifest.json');
  await writeFile(
    builtPath,
    JSON.stringify({ zip: { file: 'Astroix-darwin-arm64-0.1.0.zip', sha256: sha } }),
  );
  return { scratch, manifestDir, priorManifest, zipPath, builtPath };
}

test('the evidence law: a REFUSED qualify leaves the prior manifest bytes intact (byte-equal before and after)', {
  skip: CLI_HOST_SKIP,
  timeout: 60_000,
}, async () => {
  const stage = await stageScratchEvidence();
  try {
    const base = [
      'qualify',
      '--zip',
      stage.zipPath,
      '--expected-sha256',
      'e'.repeat(64),
      '--label',
      'selftest-preserve',
      '--manifest-dir',
      stage.manifestDir,
      '--built',
      stage.builtPath,
    ];
    // refusal 1 — a bad flag combination (downloaded mode without the transfer flags)
    const badFlags = runCandidateCli([...base, '--mode', 'downloaded']);
    assert.equal(badFlags.status, 1);
    assert.match(badFlags.stderr, /downloaded mode requires both --uploaded and --downloaded/);
    // refusal 2 — a refused draft reference (the wrong-asset direction)
    const badRef = runCandidateCli([
      ...base,
      '--mode',
      'downloaded',
      '--uploaded',
      '--downloaded',
      '--draft-ref',
      'wojtekpiskorz/astroix:pre-alpha-candidate-selftest-preserve:wrong-asset.zip',
    ]);
    assert.equal(badRef.status, 1);
    assert.match(badRef.stderr, /wrong-asset/);
    // neither refusal touched the prior evidence — byte for byte
    assert.equal(
      (await readFile(join(stage.manifestDir, 'manifest.json'))).equals(stage.priorManifest),
      true,
    );
  } finally {
    await rm(stage.scratch, { recursive: true, force: true });
  }
});

test('the evidence law: a same-label re-run over an existing manifest is refused with a named code, never a rewrite', {
  skip: CLI_HOST_SKIP,
  timeout: 60_000,
}, async () => {
  const stage = await stageScratchEvidence();
  try {
    const run = runCandidateCli([
      'qualify',
      '--zip',
      stage.zipPath,
      '--expected-sha256',
      'e'.repeat(64),
      '--label',
      'selftest-immutable',
      '--manifest-dir',
      stage.manifestDir,
      '--built',
      stage.builtPath,
      '--mode',
      'dry-run',
    ]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /evidence-exists/);
    assert.equal(
      (await readFile(join(stage.manifestDir, 'manifest.json'))).equals(stage.priorManifest),
      true,
    );
  } finally {
    await rm(stage.scratch, { recursive: true, force: true });
  }
});

test('the one-build honesty law: a bare downloaded-qualify without observation or attestation is refused — it can never record builtOnce: true', {
  skip: CLI_HOST_SKIP,
  timeout: 60_000,
}, async () => {
  const stage = await stageScratchEvidence();
  try {
    const freshDir = join(stage.scratch, 'fresh-evidence');
    const run = runCandidateCli([
      'qualify',
      '--zip',
      stage.zipPath,
      '--expected-sha256',
      'e'.repeat(64),
      '--label',
      'selftest-bare',
      '--manifest-dir',
      freshDir,
      '--mode',
      'downloaded',
      '--uploaded',
      '--downloaded',
    ]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /qualify needs --built/);
    // nothing was written — the misuse fires before any gate or matrix runs
    assert.equal(existsSync(freshDir), false);
  } finally {
    await rm(stage.scratch, { recursive: true, force: true });
  }
});

test('the one-build honesty law: an attestation naming a build whose checksum is not the received bytes refuses as wrong-checksum', {
  skip: CLI_HOST_SKIP,
  timeout: 60_000,
}, async () => {
  const stage = await stageScratchEvidence();
  try {
    const wrongBuilt = join(stage.scratch, 'wrong-build-manifest.json');
    await writeFile(
      wrongBuilt,
      JSON.stringify({
        zip: { file: 'Astroix-darwin-arm64-0.1.0.zip', sha256: 'f'.repeat(64) },
      }),
    );
    const freshDir = join(stage.scratch, 'fresh-evidence');
    const run = runCandidateCli([
      'qualify',
      '--zip',
      stage.zipPath,
      '--expected-sha256',
      'e'.repeat(64),
      '--label',
      'selftest-attest',
      '--manifest-dir',
      freshDir,
      '--built',
      wrongBuilt,
      '--mode',
      'dry-run',
    ]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /wrong-checksum/);
    // the destination is never touched by a refusal
    assert.equal(existsSync(freshDir), false);
  } finally {
    await rm(stage.scratch, { recursive: true, force: true });
  }
});
