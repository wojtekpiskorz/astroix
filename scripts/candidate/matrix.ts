import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
// H6's own battery-verdict parser (the .mjs module is import-inert; its
// narrow type surface is declared in h6-recorder.d.ts)
import { batteryVerdict } from '../../apps/desktop/scripts/run-early-package-smoke.mjs';
import {
  PRODUCT_BUNDLE_ID,
  PRODUCT_MINIMUM_MACOS,
  PRODUCT_NAME,
} from '../../apps/desktop/src/forge/product.ts';
import { fileFacts, verifyTransfer } from './checksum.ts';
import { captureHostFacts, macOsClaim } from './host-facts.ts';
import {
  type CandidateManifest,
  MATRIX_LEGS,
  type ManifestDraft,
  type MatrixLegRecord,
  serializeManifest,
  validateManifest,
} from './manifest.ts';
import { runSqliteLeg } from './native-fixture.ts';
import { runNodeSassLeg } from './node-sass-fixture.ts';
import { CHARTER_PINS, type ManifestPinTables } from './pins.ts';
import { removeStaging, runRegistryLeaseLeg } from './registry-lease.ts';

/**
 * The qualification matrix of the restricted-candidate workflow (#259,
 * L2): everything the ticket's AC names, run SERIALLY against the
 * EXACT received bytes, each leg bounded and logged into the evidence
 * bundle, the manifest written incrementally and sealed fail-closed at
 * the end:
 *
 *   unsupported-node-sass   the prelaunch rejection (never installed)
 *   l1-qualification        L1's black-box harness over the ZIP (#258)
 *   registry-lease          the kernel lease held, released, re-acquired
 *   packaged-smoke          H6's early-package battery over the exact ZIP
 *   native-better-sqlite3   from-source build + in-memory execution
 *   web-checkpoint          K4's counted product battery (#257)
 *   workflow-cleanup        the staging root removed — never incomplete
 *
 * Authorities consumed, never patched (the migration policy): L1 is
 * `npm run qualify`, the packaged smoke is the early-package family
 * (H6's specs, `ASTROIX_EARLY_PACKAGE_ZIP`-bound, driven WITHOUT H6's
 * write-once recorder so this workflow's evidence never rewrites a
 * claimed record), the web checkpoint is `npm run check:web`. A red
 * leg belongs to its owning issue and forces a NEW candidate — nothing
 * here patches app, runtime, Forge, or protocol code.
 */

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

export interface MatrixInput {
  readonly label: string;
  readonly mode: 'dry-run' | 'downloaded';
  readonly zipPath: string;
  readonly expectedSha256: string;
  readonly manifestDir: string;
  /** The draft asset reference (dry run: the one it WOULD use; downloaded: the one used). */
  readonly draftAsset: {
    readonly repository: string;
    readonly tag: string;
    readonly asset: string;
    readonly url: string;
    readonly visibility: string;
  };
  readonly source: {
    readonly commit: string;
    readonly clean: boolean;
    readonly porcelain: readonly string[];
  };
  readonly pins: ManifestPinTables & {
    readonly reconciled: boolean;
    readonly findings: readonly unknown[];
  };
  readonly build: {
    readonly command: string;
    readonly zip: { readonly path: string; readonly bytes: number; readonly sha256: string };
    /**
     * OBSERVED by the caller, never defaulted: true only when the
     * recording process ran the build itself (the `run` path) or
     * verified an explicit `--built` attestation naming the packaging
     * manifest these bytes came from — a bare recorder records false
     * (#259 review round 1).
     */
    readonly builtOnce: boolean;
  };
  readonly uploaded: boolean;
  readonly downloaded: boolean;
  readonly onLog?: (line: string) => void;
}

export interface MatrixResult {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly manifestPath: string;
}

export async function runMatrix(input: MatrixInput): Promise<MatrixResult> {
  const log = (line: string): void => {
    input.onLog?.(line);
  };
  await mkdir(join(input.manifestDir, 'logs'), { recursive: true });
  const startedAt = new Date().toISOString();
  const host = await captureHostFacts();
  // the builder's mutable draft: sections update by replacement, and the
  // readonly CandidateManifest is presented at the flush boundary
  const manifest: ManifestDraft = {
    schema: 1,
    workflow: 'astroix-pre-alpha-candidate',
    lane: 'L2 restricted candidate workflow (#259)',
    label: input.label,
    mode: input.mode,
    startedAt,
    finishedAt: null,
    source: input.source,
    pins: input.pins,
    build: input.build,
    transfer: {
      mode: input.mode,
      checksumBefore: input.expectedSha256,
      checksumAfter: '',
      match: false,
      uploaded: input.uploaded,
      downloaded: input.downloaded,
      draftAsset: input.draftAsset,
    },
    host,
    minimumMacOS: {
      metadata: PRODUCT_MINIMUM_MACOS,
      verifiedAs: 'metadata-only',
      testedOn: {
        swVersProduct: host.swVersProduct,
        swVersBuild: host.swVersBuild,
        unameMachine: host.unameMachine,
      },
      controlledMinimumHost: false,
      disclosure: '',
    },
    matrix: [],
    fixtures: {
      betterSqlite3: {
        executed: false,
        packageVersion: null,
        runtime: null,
        builtFromSource: false,
        builtUnder: null,
        inMemory: null,
        detail: null,
      },
      nodeSass: { rejected: false, installed: false, diagnostic: null },
    },
    verdict: null,
  };
  const failures: string[] = [];
  await flushManifest(input, manifest);

  const stagingRoot = await mkdtemp(join(tmpdir(), 'astroix-candidate-'));
  let stagingRemoved = false;
  try {
    // ——— the transfer law, then the legs, SERIALLY, each recording itself ———
    const receivedZip = await stageAndVerifyTransfer(input, manifest, failures, stagingRoot, log);
    await legUnsupportedNodeSass(input, manifest, failures);
    const l1Ok = await legL1Qualification(input, manifest, failures, receivedZip);
    const appPath = await extractReceivedApp(receivedZip, stagingRoot, failures, l1Ok);
    await legRegistryLease(input, manifest, failures, appPath, stagingRoot);
    await legPackagedSmoke(input, manifest, failures, appPath, receivedZip);
    await legNativeSqlite(input, manifest, failures, appPath);
    await legWebCheckpoint(input, manifest, failures);
  } finally {
    // ——— leg: workflow-cleanup ——— (owed on every path)
    stagingRemoved = await removeStaging(stagingRoot);
    if (!stagingRemoved) {
      failures.push(`workflow-cleanup: the staging root ${stagingRoot} could not be removed`);
    }
    await recordLeg(input, manifest, failures, {
      leg: 'workflow-cleanup',
      ok: stagingRemoved,
      summary: stagingRemoved ? 'staging root removed' : `staging root ${stagingRoot} survived`,
      exitCode: stagingRemoved ? 0 : 1,
      logFile: 'logs/workflow-cleanup.log',
    });
  }

  // ——— the macOS disclosure (always the actual tested facts) ———
  manifest.minimumMacOS = macOsClaim(host, PRODUCT_MINIMUM_MACOS);

  // ——— seal: verdict + the fail-closed completeness re-read ———
  manifest.finishedAt = new Date().toISOString();
  manifest.verdict = { ok: failures.length === 0, failures: [...failures] };
  await flushManifest(input, manifest);
  const reread = JSON.parse(
    await readFile(join(input.manifestDir, 'manifest.json'), 'utf8'),
  ) as CandidateManifest;
  const completeness = validateManifest(reread, PRODUCT_MINIMUM_MACOS);
  if (!completeness.ok) {
    failures.push(...completeness.problems.map((problem) => `evidence: ${problem}`));
  }
  manifest.verdict = { ok: failures.length === 0, failures: [...failures] };
  await flushManifest(input, manifest);
  log(
    `candidate: matrix ${failures.length === 0 ? 'PASSED' : 'FAILED'} — evidence at ${input.manifestDir}`,
  );
  for (const failure of failures) {
    log(`candidate: FAILURE — ${failure}`);
  }
  return {
    ok: failures.length === 0,
    failures,
    manifestPath: join(input.manifestDir, 'manifest.json'),
  };
}

/**
 * The transfer law: one checksum across assembled and received bytes. A
 * dry run stages the assembled bytes as the would-be downloaded asset
 * first; the returned path is the received ZIP a tester would hold.
 */
async function stageAndVerifyTransfer(
  input: MatrixInput,
  manifest: ManifestDraft,
  failures: string[],
  stagingRoot: string,
  log: (line: string) => void,
): Promise<string> {
  log(`candidate: verifying the one-build law over ${input.zipPath}`);
  const assembledFacts = await fileFacts(input.zipPath);
  let receivedZip = input.zipPath;
  if (input.mode === 'dry-run') {
    const receivedDir = join(stagingRoot, 'received');
    await mkdir(receivedDir, { recursive: true });
    receivedZip = join(receivedDir, input.draftAsset.asset);
    await copyFile(input.zipPath, receivedZip);
    log('candidate: dry run — the assembled bytes staged as the would-be downloaded asset');
  }
  const receivedFacts = await fileFacts(receivedZip);
  const transfer = verifyTransfer({
    expected: input.expectedSha256,
    assembled: assembledFacts.sha256,
    received: receivedFacts.sha256,
  });
  manifest.transfer = {
    ...manifest.transfer,
    checksumAfter: receivedFacts.sha256,
    match: transfer.ok,
  };
  if (!transfer.ok) {
    failures.push(
      `transfer: ${String(transfer.failure?.code)} — ${String(transfer.failure?.detail)}`,
    );
  }
  await flushManifest(input, manifest);
  return receivedZip;
}

/** Leg: unsupported-node-sass — the prelaunch rejection, never installed. */
async function legUnsupportedNodeSass(
  input: MatrixInput,
  manifest: ManifestDraft,
  failures: string[],
): Promise<void> {
  const sassLog = logSink(input.manifestDir, 'unsupported-node-sass');
  const sass = await runNodeSassLeg({
    fixtureDir: join(ROOT, 'qualification', 'fixtures', 'unsupported-node-sass'),
    runtimeNode: CHARTER_PINS.node,
    runtimeAbi: CHARTER_PINS.nodeAbi,
    os: process.platform,
    arch: process.arch,
    onLog: sassLog,
  });
  manifest.fixtures = {
    ...manifest.fixtures,
    nodeSass: { rejected: sass.ok, installed: false, diagnostic: sass.diagnostic },
  };
  await recordLeg(input, manifest, failures, {
    leg: 'unsupported-node-sass',
    ok: sass.ok,
    summary: sass.ok
      ? 'node-sass 9 rejected prelaunch with the structured diagnostic (package, version, runtime, OS, architecture, upstream-support) — never installed'
      : sass.findings.join('; '),
    exitCode: sass.ok ? 0 : 1,
    logFile: 'logs/unsupported-node-sass.log',
  });
}

/** Leg: L1's black-box qualification over the exact received bytes. Returns whether L1 passed. */
async function legL1Qualification(
  input: MatrixInput,
  manifest: ManifestDraft,
  failures: string[],
  receivedZip: string,
): Promise<boolean> {
  const l1Log = logSink(input.manifestDir, 'l1-qualification');
  const l1Evidence = join(input.manifestDir, 'l1-evidence');
  await rm(l1Evidence, { recursive: true, force: true });
  const l1 = await runBounded(
    'npm',
    [
      'run',
      'qualify',
      '--',
      '--artifact',
      receivedZip,
      '--expected-sha256',
      input.expectedSha256,
      '--evidence',
      l1Evidence,
    ],
    30 * 60_000,
    l1Log,
  );
  await recordLeg(input, manifest, failures, {
    leg: 'l1-qualification',
    ok: l1.exitCode === 0,
    summary:
      l1.exitCode === 0
        ? 'L1 qualified the exact received bytes (evidence under l1-evidence/, exit 0)'
        : `L1 rejected the candidate (exit ${String(l1.exitCode)}) — see logs/l1-qualification.log and l1-evidence/`,
    exitCode: l1.exitCode,
    logFile: 'logs/l1-qualification.log',
  });
  return l1.exitCode === 0;
}

/**
 * The extraction the boot-dependent legs share: the received ZIP must
 * extract to exactly one Astroix.app. Returns its path, or null when
 * there is nothing to boot.
 */
async function extractReceivedApp(
  receivedZip: string,
  stagingRoot: string,
  failures: string[],
  l1Ok: boolean,
): Promise<string | null> {
  if (!l1Ok) return null;
  const extractDir = join(stagingRoot, 'extracted');
  await mkdir(extractDir, { recursive: true });
  await execFileAsync('ditto', ['-x', '-k', receivedZip, extractDir], {
    timeout: 5 * 60_000,
  }).catch(() => undefined);
  const appPath = join(extractDir, `${PRODUCT_NAME}.app`);
  if (!existsSync(appPath)) {
    failures.push('extraction: the received ZIP did not extract to exactly one Astroix.app');
    return null;
  }
  return appPath;
}

/** Leg: registry-lease — two boots, hold/release/re-acquire (a skipped leg never passes). */
async function legRegistryLease(
  input: MatrixInput,
  manifest: ManifestDraft,
  failures: string[],
  appPath: string | null,
  stagingRoot: string,
): Promise<void> {
  if (appPath === null) {
    await skipLeg(
      input,
      manifest,
      failures,
      'registry-lease',
      'the artifact never earned a boot (intake or extraction failed)',
    );
    return;
  }
  const leaseLog = logSink(input.manifestDir, 'registry-lease');
  const lease = await runRegistryLeaseLeg({
    appPath,
    executableName: PRODUCT_NAME,
    bundleId: PRODUCT_BUNDLE_ID,
    stagingRoot: join(stagingRoot, 'lease-boot'),
    bootTimeoutMs: 90_000,
    quitTimeoutMs: 90_000,
    onLog: leaseLog,
  });
  await recordLeg(input, manifest, failures, {
    leg: 'registry-lease',
    ok: lease.ok,
    summary: lease.ok
      ? 'the registry-writer kernel lease was held (0600 in 0700 private-state) through both boots, released by the first exit, re-acquired by the second, and nothing survived'
      : lease.findings.join('; '),
    exitCode: lease.ok ? 0 : 1,
    logFile: 'logs/registry-lease.log',
  });
}

/** Leg: packaged-smoke — H6's early-package family over the exact bytes (a skipped leg never passes). */
async function legPackagedSmoke(
  input: MatrixInput,
  manifest: ManifestDraft,
  failures: string[],
  appPath: string | null,
  receivedZip: string,
): Promise<void> {
  if (appPath === null) {
    await skipLeg(
      input,
      manifest,
      failures,
      'packaged-smoke',
      'the artifact never earned a boot (intake or extraction failed)',
    );
    return;
  }
  const smokeLog = logSink(input.manifestDir, 'packaged-smoke');
  const vitestBin = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const smoke = await runBounded(
    process.execPath,
    [
      vitestBin,
      'run',
      '--config',
      'apps/desktop/smoke/vitest.config.ts',
      'e2e/desktop/early-package',
    ],
    45 * 60_000,
    smokeLog,
    { ASTROIX_EARLY_PACKAGE_ZIP: receivedZip },
  );
  const verdict = batteryVerdict(smoke.text(), smoke.exitCode ?? 1);
  await recordLeg(input, manifest, failures, {
    leg: 'packaged-smoke',
    ok: verdict.ok,
    summary: `the early-package battery over the exact received bytes: ${String(verdict.passed)} passed, ${String(verdict.failed)} failed, ${String(verdict.skipped)} skipped (exit ${String(smoke.exitCode)})`,
    exitCode: smoke.exitCode,
    logFile: 'logs/packaged-smoke.log',
    counts: { passed: verdict.passed, failed: verdict.failed, skipped: verdict.skipped },
  });
}

/** Leg: native-better-sqlite3 — from source, executed under the artifact's node (a skipped leg never passes). */
async function legNativeSqlite(
  input: MatrixInput,
  manifest: ManifestDraft,
  failures: string[],
  appPath: string | null,
): Promise<void> {
  if (appPath === null) {
    await skipLeg(
      input,
      manifest,
      failures,
      'native-better-sqlite3',
      'the artifact never earned a boot (intake or extraction failed)',
    );
    return;
  }
  const nativeLog = logSink(input.manifestDir, 'native-better-sqlite3');
  const sqlite = await runSqliteLeg({
    appPath,
    nodePin: CHARTER_PINS.node,
    nodeAbi: CHARTER_PINS.nodeAbi,
    packageVersion: '12.10.0',
    onLog: nativeLog,
  });
  manifest.fixtures = { ...manifest.fixtures, betterSqlite3: sqlite.facts };
  await recordLeg(input, manifest, failures, {
    leg: 'native-better-sqlite3',
    ok: sqlite.ok,
    summary: sqlite.ok
      ? `better-sqlite3 12.10.0 built from source under ${CHARTER_PINS.node} and executed by the artifact's bundled binary (${String(sqlite.facts.runtime?.node)}, ABI ${String(sqlite.facts.runtime?.abi)}) — in-memory create/insert/select/close green`
      : sqlite.findings.join('; '),
    exitCode: sqlite.ok ? 0 : 1,
    logFile: 'logs/native-better-sqlite3.log',
  });
}

/** Leg: web-checkpoint — K4's counted product battery. */
async function legWebCheckpoint(
  input: MatrixInput,
  manifest: ManifestDraft,
  failures: string[],
): Promise<void> {
  const webLog = logSink(input.manifestDir, 'web-checkpoint');
  const web = await runBounded('npm', ['run', 'check:web'], 45 * 60_000, webLog);
  const casesLine = /cases:\s+(\d+)/.exec(web.text())?.[1];
  await recordLeg(input, manifest, failures, {
    leg: 'web-checkpoint',
    ok: web.exitCode === 0,
    summary:
      web.exitCode === 0
        ? `the K4 web protocol checkpoint passed the counted battery${casesLine !== undefined ? ` (${casesLine} cases)` : ''}`
        : `the K4 web protocol checkpoint failed (exit ${String(web.exitCode)}) — see logs/web-checkpoint.log and test-results/`,
    exitCode: web.exitCode,
    logFile: 'logs/web-checkpoint.log',
    ...(casesLine !== undefined ? { counts: { cases: Number(casesLine) } } : {}),
  });
}

// ——— helpers ———

/** One bounded leg spawn with output teed into its log file. */
interface BoundedRun {
  readonly exitCode: number | null;
  readonly signal: string | null;
  text(): string;
}
function runBounded(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  sink: (chunk: string) => void,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<BoundedRun> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    const timer = setTimeout(() => {
      sink(`\n(candidate: leg timed out after ${String(timeoutMs)} ms — killed)\n`);
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      const piece = chunk.toString('utf8');
      text += piece;
      sink(piece);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const piece = chunk.toString('utf8');
      text += piece;
      sink(piece);
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      sink(`\n(candidate: spawn error — ${error.message})\n`);
      resolve({ exitCode: null, signal: null, text: () => text });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal: signal, text: () => text });
    });
  });
}

/**
 * A log sink for one leg: chunks APPEND to the leg's log file (the log
 * grows linearly — never a whole-file rewrite per chunk), serialized so
 * chunks never interleave.
 */
function logSink(manifestDir: string, leg: string): (chunk: string) => void {
  const path = join(manifestDir, 'logs', `${leg}.log`);
  let pending: Promise<void> = Promise.resolve();
  return (chunk: string): void => {
    process.stdout.write(chunk);
    pending = pending.then(() => appendFile(path, chunk)).catch(() => undefined);
  };
}

/** The one manifest flush every writer shares: the draft's current state, on disk. */
async function flushManifest(input: MatrixInput, manifest: ManifestDraft): Promise<void> {
  await writeFile(join(input.manifestDir, 'manifest.json'), serializeManifest(manifest));
}

/**
 * Records one leg verdict into the manifest (in run order), ledgers
 * failures, and flushes to disk — the incremental-write law: a crashed
 * or timed-out run leaves the record of every leg it earned, never an
 * empty matrix the logs contradict.
 */
async function recordLeg(
  input: MatrixInput,
  manifest: ManifestDraft,
  failures: string[],
  record: {
    leg: (typeof MATRIX_LEGS)[number];
    ok: boolean;
    summary: string;
    exitCode: number | null;
    logFile: string;
    counts?: Readonly<Record<string, number>>;
  },
): Promise<void> {
  const entry: MatrixLegRecord = {
    leg: record.leg,
    status: record.ok ? 'passed' : 'failed',
    summary: record.summary,
    exitCode: record.exitCode,
    logFile: record.logFile,
    ...(record.counts !== undefined ? { counts: record.counts } : {}),
  };
  const next = [...manifest.matrix.filter((leg) => leg.leg !== record.leg), entry].sort(
    (a, b) => MATRIX_LEGS.indexOf(a.leg) - MATRIX_LEGS.indexOf(b.leg),
  );
  manifest.matrix = next;
  if (!record.ok) failures.push(`${record.leg}: ${record.summary}`);
  await flushManifest(input, manifest);
}

/** Records a skipped leg as a failure-shaped record (a skipped leg never passes a candidate). */
async function skipLeg(
  input: MatrixInput,
  manifest: ManifestDraft,
  failures: string[],
  leg: (typeof MATRIX_LEGS)[number],
  reason: string,
): Promise<void> {
  await mkdir(join(input.manifestDir, 'logs'), { recursive: true }).catch(() => undefined);
  await writeFile(join(input.manifestDir, 'logs', `${leg}.log`), `SKIPPED — ${reason}\n`).catch(
    () => undefined,
  );
  await recordLeg(input, manifest, failures, {
    leg,
    ok: false,
    summary: `SKIPPED — ${reason} (a candidate matrix leg never passes by skip)`,
    exitCode: null,
    logFile: `logs/${leg}.log`,
  });
}
