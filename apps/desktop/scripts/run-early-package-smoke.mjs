import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * The early packaged-smoke orchestrator (#248, H6; ADR-0008 — the
 * packaged smoke is H6's evidence, LOCAL-ONLY, never `npm test`, never
 * CI): the ONE command that produces a labeled hardened build, runs
 * the early-package spec family against its EXACT extracted ZIP, and
 * records the evidence under `apps/desktop/test-results/early-package-smoke/`.
 *
 *   node apps/desktop/scripts/run-early-package-smoke.mjs
 *     --label <candidate-label>   the packaging label (default early-smoke)
 *     --zip <path>                reuse an EXISTING build's ZIP instead of
 *                                 packaging (records which artifact was
 *                                 smoked — the no-rebuild law's input side)
 *     --force                     overwrite a previously recorded run's
 *                                 evidence — refused when the existing
 *                                 record is COMMITTED (git history is the
 *                                 claim mechanism; a claimed exact run is
 *                                 retracted only by an explicit git rm in
 *                                 its own commit, never silently)
 *
 * The staged flow:
 *
 *   1. package — `npm run package -- --label <label>` (real Forge, real
 *      ad-hoc codesign, the ZIP as sole deliverable) unless --zip names
 *      an existing artifact
 *   2. the battery — vitest over the desktop smoke config filtered to
 *      the early-package specs, with `ASTROIX_EARLY_PACKAGE_ZIP` bound
 *      to the exact ZIP (the specs refuse any other artifact); the
 *      `early-package-evidence: ` lines the specs print are the run
 *      log's spine
 *   3. the evidence record — evidence.json: the artifact's identity
 *      (ZIP path + SHA-256 + size), the source commit, the machine
 *      facts (sw_vers, uname -m), the battery's pass/fail summary, and
 *      the honest BLOCKED-LEG record (activation, canvas,
 *      HMR-through-proxy, Service-Worker-bypass observations require
 *      the desktop control-plane composition — not packaged at #248;
 *      the owning issue carries the finding)
 *
 * Migration policy (the ticket's law): no upload, tag, publish, or
 * rebuild after recording a claimed exact run — a claim is a COMMITTED
 * evidence record (git history is the mechanism; `--force` refuses to
 * discard one), and the evidence names the exact ZIP bytes it smoked.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, '..');
const ROOT = join(DESKTOP, '..', '..');
const EVIDENCE_DIR = join(DESKTOP, 'test-results', 'early-package-smoke');
const MAKER_ZIP_DIR = join(DESKTOP, 'out', 'make', 'zip', 'darwin', 'arm64');
const execFileAsync = promisify(execFile);

const LABEL = cliValue('--label') ?? 'early-smoke';
const ZIP_ARGUMENT = cliValue('--zip');
const FORCE = process.argv.includes('--force');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error('run-early-package-smoke: the packaged product is macOS arm64 only (ADR-0008)');
  process.exit(1);
}

// ——— 0. the evidence record is write-once ———

const EVIDENCE_FILE = join(EVIDENCE_DIR, 'evidence.json');
if (existsSync(EVIDENCE_FILE) && !FORCE) {
  console.error(
    `run-early-package-smoke: a recorded run already exists at ${relative(ROOT, EVIDENCE_DIR)} — ` +
      'the no-rebuild-after-recording law (pass --force only to discard an unclaimed run)',
  );
  process.exit(1);
}
if (existsSync(EVIDENCE_FILE) && FORCE) {
  // The claim mechanism is git history: a COMMITTED evidence record is
  // a claimed exact run, and --force cannot silently discard it — the
  // claim is retracted explicitly (a visible `git rm` of the record in
  // its own commit) before re-recording.
  if (await evidenceIsClaimed()) {
    console.error(
      `run-early-package-smoke: refusing --force — the recorded run at ${relative(ROOT, EVIDENCE_FILE)} is ` +
        'committed (a CLAIMED exact run; the no-rebuild law). To supersede it, retract the claim ' +
        'explicitly: git rm the evidence in its own commit, then re-record.',
    );
    process.exit(1);
  }
  console.log(
    'run-early-package-smoke: --force discards the UNCLAIMED (uncommitted) recorded run — re-recording',
  );
}
await rm(EVIDENCE_DIR, { recursive: true, force: true });
await mkdir(EVIDENCE_DIR, { recursive: true });

// ——— 1. the artifact: package a labeled build, or adopt an existing one ———

const zip = ZIP_ARGUMENT ?? (await packageLabeledBuild());
if (!existsSync(zip)) {
  console.error(`run-early-package-smoke: the ZIP does not exist (${zip})`);
  process.exit(1);
}
const [zipSha, zipBytes, sourceCommit, swVers, unameM] = await Promise.all([
  sha256(zip),
  stat(zip).then((info) => info.size),
  gitCommit(),
  capture('sw_vers', ['-productVersion']),
  capture('uname', ['-m']),
]);
const startedAt = new Date().toISOString();
console.log(
  `run-early-package-smoke: artifact ${relative(ROOT, zip)} (${Math.round(zipBytes / 1e6)} MB, sha256 ${zipSha.slice(0, 16)}…)`,
);

// ——— 2. the battery over the exact artifact ———

const battery = await runBattery(zip);

// ——— 3. the evidence record ———

const evidence = {
  lane: 'H6 early packaged smoke (#248)',
  startedAt,
  finishedAt: new Date().toISOString(),
  artifact: {
    zip: relative(ROOT, zip),
    sha256: zipSha,
    bytes: zipBytes,
    packagingLabel: LABEL,
    reusedExistingZip: ZIP_ARGUMENT !== undefined,
  },
  sourceCommit,
  host: { productVersion: swVers, arch: unameM, harnessNode: process.version },
  battery: {
    command:
      'npm run test:desktop (the early-package family; ASTROIX_EARLY_PACKAGE_ZIP bound to the exact ZIP)',
    passed: battery.passed,
    failed: battery.failed,
    skipped: battery.skipped,
    ok: battery.failed === 0,
  },
  blockedLegs: [
    {
      leg: 'activation with same-origin direct canvas DOM access and zero-injection hosting loop',
      reason:
        'the desktop control-plane composition (origin listener, launcher, project runtime, canvas) is not packaged — the child answers the settled unavailable-composition refusal',
      owningSurface: 'apps/desktop/src/main/control-plane-child.ts + the missing composition seam',
    },
    {
      leg: 'hostile Service Worker bypass and document authority observed in the packaged app',
      reason:
        'the H4/H5 surfaces are pure seams with real-Electron harness lanes; no packaged editing target exists to observe them on',
      owningSurface: 'apps/desktop/src/document-authority/** + apps/desktop/src/service-worker/**',
    },
    {
      leg: 'Vite HMR connecting through the packaged proxy',
      reason: 'no project origin or proxy is composed into the packaged host',
      owningSurface: 'packages/runtime origin/proxy composition into the desktop child',
    },
  ],
};
await writeFile(join(EVIDENCE_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
await writeFile(join(EVIDENCE_DIR, 'run.log'), battery.log);
console.log(
  `run-early-package-smoke: evidence recorded at ${relative(ROOT, EVIDENCE_DIR)} ` +
    `(battery: ${battery.passed} passed, ${battery.failed} failed, ${battery.skipped} skipped)`,
);
if (battery.failed > 0) process.exit(1);

// ——— helpers ———

function cliValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv.at(index + 1);
}

/** True when the recorded evidence is git-TRACKED — a committed (claimed) exact run. */
async function evidenceIsClaimed() {
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', relative(ROOT, EVIDENCE_FILE)], {
      cwd: ROOT,
      timeout: 30_000,
    });
    return true;
  } catch {
    return false; // untracked (or no git) — unclaimed, --force may discard
  }
}

/** One labeled hardened build through H3's pipeline; returns its ZIP. */
async function packageLabeledBuild() {
  const before = new Set(listZipNames());
  console.log(`run-early-package-smoke: packaging the labeled build (--label ${LABEL})…`);
  await runStep('npm', ['run', 'package', '--', '--label', LABEL], ROOT, 30 * 60_000);
  const fresh = listZipNames().filter((name) => !before.has(name));
  if (fresh.length === 1) return join(MAKER_ZIP_DIR, fresh[0]);
  const present = listZipNames();
  if (present.length === 1) return join(MAKER_ZIP_DIR, present[0]);
  console.error(
    `run-early-package-smoke: cannot identify the smoked ZIP among ${JSON.stringify(present)} — pass --zip explicitly`,
  );
  process.exit(1);
}

function listZipNames() {
  if (!existsSync(MAKER_ZIP_DIR)) return [];
  return readdirSync(MAKER_ZIP_DIR).filter((name) => name.endsWith('.zip'));
}

/** The battery: vitest over the desktop smoke config, the early-package family only. */
async function runBattery(zip) {
  const vitestBin = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const args = [
    'run',
    '--config',
    'apps/desktop/smoke/vitest.config.ts',
    'e2e/desktop/early-package-smoke.spec.ts',
    'e2e/desktop/early-package-tamper.spec.ts',
    'e2e/desktop/early-package-repeated-run.spec.ts',
  ];
  const chunks = [];
  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [vitestBin, ...args], {
      cwd: ROOT,
      env: { ...process.env, ASTROIX_EARLY_PACKAGE_ZIP: zip },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => {
      chunks.push(chunk);
      process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      chunks.push(chunk);
      process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      console.error(`run-early-package-smoke: vitest failed to spawn (${error.message})`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
  const text = Buffer.concat(chunks).toString('utf8');
  // The reporter's own bottom line is the authority; a nonzero exit with
  // an unparsable line still counts as failed, never silently green.
  const bottomLine = text.match(/Tests\s+(\d+) passed(?: \| (\d+) failed)?(?: \| (\d+) skipped)?/);
  const passed = bottomLine !== null ? Number(bottomLine[1]) : 0;
  const failed = bottomLine !== null ? Number(bottomLine[2] ?? 0) : exitCode === 0 ? 0 : 1;
  const skipped = bottomLine !== null ? Number(bottomLine[3] ?? 0) : 0;
  return { passed, failed, skipped, exitCode, log: text };
}

function runStep(command, args, cwd, timeout) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`${command} timed out after ${timeout} ms`));
    }, timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) done();
      else fail(new Error(`${command} exited with ${code}`));
    });
  }).catch((error) => {
    console.error(
      `run-early-package-smoke: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function gitCommit() {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

async function capture(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 30_000 });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}
