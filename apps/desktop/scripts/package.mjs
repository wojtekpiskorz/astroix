import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  PACKAGED_ELECTRON_PIN,
  PACKAGED_FORGE_PIN,
  PACKAGED_NODE_PIN,
} from '../../../packages/runtime/src/internal/packaged-assets.ts';
import { adHocSignApp, isMachOFile } from '../src/forge/codesign.ts';
import {
  buildCandidateManifest,
  buildPayloadInventory,
  findForbiddenArtifacts,
  serializeCandidateManifest,
  sha256File,
} from '../src/forge/inventory.ts';
import {
  describePackageVerification,
  verifyPackagedApp,
  verifyPackagedAppFacts,
} from '../src/forge/package-verification.ts';
import {
  PRODUCT_ARCH,
  PRODUCT_BUNDLE_ID,
  PRODUCT_MINIMUM_MACOS,
  PRODUCT_NAME,
  PRODUCT_PLATFORM,
} from '../src/forge/product.ts';

/**
 * The packaging pipeline orchestrator (#245, H3; ADR-0008): the ONE
 * local-only lane that produces the ratified unsigned artifact —
 * `npm run package` (never `npm test`, never CI; like `test:desktop`
 * and `certify:adapter`, it downloads real artifacts and runs real
 * `codesign`). Checkpoint-only by migration policy: normal development
 * stays on the fast web/local workflows.
 *
 * The ordered stages, each failing closed:
 *
 *   1. assemble the immutable runtime resources (H2's own script — the
 *      stock Node distribution + the rebased control-plane runtime,
 *      self-verifying through the packaged-asset adapter)
 *   2. bundle the Electron main (the H1 smoke builder — the packaged
 *      main is the same bundle the dev workflow runs)
 *   3. `electron-forge package --platform darwin --arch arm64`
 *      (Forge pinned exactly 7.11.2; Packager + FusesPlugin; the ZIP
 *      maker runs later; no Forge Vite plugin)
 *   4. PRE-SIGN verification: fuses final (read off the real binary)
 *      and resources final (the packaged-asset adapter) — nothing is
 *      signed until both hold
 *   5. ad-hoc sign with identity '-': nested executable code first,
 *      the outer app LAST
 *   6. POST-SIGN strict verification: `codesign --verify --strict` on
 *      every nested target and the outer app, adhoc signatures, plus
 *      the full fact facets again
 *   7. `electron-forge make --skip-package` — the ZIP, the sole
 *      deliverable (negative-checked: no DMG, no RELEASES.json)
 *   8. the candidate manifest (normalized payload inventory + immutable
 *      hashes + fuse states + ZIP checksum) under out/candidates/<label>/
 *   9. extract the ZIP (ditto) and run the SAME verification on the
 *      extracted app — the ADR-0008 law that verification runs again
 *      after extraction
 *
 * Accepted residual (the #245 carry-note): the verify-then-spawn TOCTOU
 * window is accepted under ADR-0008's threat model; a future
 * Developer-ID-signed + notarized bundle is the lane that revisits it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, '..');
const ROOT = join(DESKTOP, '..', '..');
const OUT_DIR = join(DESKTOP, 'out');
const APP_DIR_NAME = `${PRODUCT_NAME}-${PRODUCT_PLATFORM}-${PRODUCT_ARCH}`;
const APP_PATH = join(OUT_DIR, APP_DIR_NAME, `${PRODUCT_NAME}.app`);
const FORGE_CLI = join(ROOT, 'node_modules', '@electron-forge', 'cli', 'dist', 'electron-forge.js');
const RAW_NODE_FLAGS = [
  '--experimental-transform-types',
  '--import',
  './apps/desktop/raw-node-register.mjs',
];
const LABEL = cliValue('--label') ?? 'candidate';
const execFileAsync = promisify(execFile);

// ——— the v1 product shape (ADR-0008): exactly one macOS arm64 app ———

if (process.platform !== PRODUCT_PLATFORM || process.arch !== PRODUCT_ARCH) {
  console.error(
    `package: the packaged product is macOS arm64 only (ADR-0008); refusing to package on ${process.platform}-${process.arch}`,
  );
  process.exit(1);
}

// ——— 1 + 2. the inputs the fast workflows share ———

await run(
  'assemble-runtime',
  process.execPath,
  [...RAW_NODE_FLAGS, 'apps/desktop/scripts/assemble-runtime.mjs'],
  ROOT,
);
await run('build-main', process.execPath, ['apps/desktop/smoke/build-main.mjs'], ROOT);
if (!existsSync(join(DESKTOP, 'dist-main', 'main.js'))) {
  console.error('package: the main bundle is missing (apps/desktop/dist-main/main.js)');
  process.exit(1);
}

// ——— 3. Forge package (Packager + FusesPlugin) ———

// the forge-managed subtrees go; out/candidates SURVIVES — the
// candidate manifests are the comparison record two builds need to
// coexist (and the L1/L2 lanes' input), never disposable build scratch
await rm(join(OUT_DIR, APP_DIR_NAME), { recursive: true, force: true });
await rm(join(OUT_DIR, 'make'), { recursive: true, force: true });
await run(
  'forge-package',
  process.execPath,
  [FORGE_CLI, 'package', DESKTOP, '--platform', PRODUCT_PLATFORM, '--arch', PRODUCT_ARCH],
  DESKTOP,
  15 * 60_000,
);
if (!existsSync(APP_PATH)) {
  console.error(`package: Forge did not produce ${relative(ROOT, APP_PATH)}`);
  process.exit(1);
}

// ——— 4. PRE-SIGN: resources and fuses final BEFORE any signature ———

// the facts pass is the ONE fuse judge (its fuses facet reads the wire
// and compares against the release law); the manifest below carries the
// states it already read
const preSign = await verifyPackagedAppFacts(APP_PATH);
if (!preSign.assets.ok || !preSign.fuses.ok || !preSign.plist.ok || !preSign.arch.ok) {
  console.error(
    `package: PRE-SIGN verification failed — refusing to sign ${JSON.stringify(preSign)}`,
  );
  process.exit(1);
}
console.log(
  'package: PRE-SIGN — fuses final, resources verified (assets/fuses/identity/arch all green)',
);

// ——— 5. ad-hoc signing: nested first, the outer app last ———

const signed = await adHocSignApp(APP_PATH);
console.log(
  `package: ad-hoc signed (identity '-') — ${signed.length} nested targets, outer app last`,
);

// ——— 6. POST-SIGN strict verification ———

const postSign = await verifyPackagedApp(APP_PATH);
for (const line of describePackageVerification(postSign)) console.log(line);
if (!postSign.ok) process.exit(1);

// ——— 7. the ZIP — the sole deliverable ———

await run(
  'forge-make-zip',
  process.execPath,
  [
    FORGE_CLI,
    'make',
    DESKTOP,
    '--skip-package',
    '--platform',
    PRODUCT_PLATFORM,
    '--arch',
    PRODUCT_ARCH,
  ],
  DESKTOP,
  15 * 60_000,
);
const zipDir = join(OUT_DIR, 'make', 'zip', PRODUCT_PLATFORM, PRODUCT_ARCH);
const zipPath = await soleArtifact(zipDir, '.zip', 'the ZIP (the sole deliverable)');
await assertNoForbiddenArtifacts(OUT_DIR);

// ——— 8. the candidate manifest + checksums ———

const [zipSha, version, sourceCommit] = await Promise.all([
  sha256File(zipPath),
  readVersion(),
  gitCommit(),
]);
const payload = await buildPayloadInventory(APP_PATH, (rel) =>
  isMachOFile(join(APP_PATH, ...rel.split('/'))),
);
const manifest = buildCandidateManifest({
  product: PRODUCT_NAME,
  version,
  sourceCommit,
  electron: PACKAGED_ELECTRON_PIN,
  forge: PACKAGED_FORGE_PIN,
  node: PACKAGED_NODE_PIN,
  minimumSystemVersion: PRODUCT_MINIMUM_MACOS,
  fuseStates: preSign.fuses.detail.states,
  zip: {
    file: zipPath.split('/').pop() ?? zipPath,
    bytes: (await stat(zipPath)).size,
    sha256: zipSha,
  },
  payload,
});
const candidateDir = join(OUT_DIR, 'candidates', LABEL);
await rm(candidateDir, { recursive: true, force: true });
await mkdir(candidateDir, { recursive: true });
await writeFile(join(candidateDir, 'manifest.json'), serializeCandidateManifest(manifest));
await writeFile(
  join(candidateDir, 'checksums.sha256'),
  `${zipSha}  ${manifest.zip.file} (bundle id ${PRODUCT_BUNDLE_ID}, min macOS ${PRODUCT_MINIMUM_MACOS}, commit ${sourceCommit})\n`,
);

// ——— 9. verification runs AGAIN after ZIP extraction ———

const extractDir = await mkdtemp(join(tmpdir(), 'astroix-package-verify-'));
try {
  await run('extract-zip', 'ditto', ['-x', '-k', zipPath, extractDir], ROOT, 5 * 60_000);
  const extracted = await readdir(extractDir);
  if (extracted.length !== 1 || extracted[0] !== `${PRODUCT_NAME}.app`) {
    console.error(
      `package: the extracted ZIP root is not exactly ${PRODUCT_NAME}.app: ${JSON.stringify(extracted)}`,
    );
    process.exit(1);
  }
  const extractedReport = await verifyPackagedApp(join(extractDir, `${PRODUCT_NAME}.app`));
  for (const line of describePackageVerification(extractedReport)) console.log(line);
  if (!extractedReport.ok) process.exit(1);
} finally {
  await rm(extractDir, { recursive: true, force: true });
}

console.log(
  `package: DONE — ${relative(ROOT, zipPath)} (${Math.round(manifest.zip.bytes / 1e6)} MB, sha256 ${zipSha.slice(0, 16)}…)`,
);
console.log(
  `package: candidate manifest + checksums at ${relative(ROOT, candidateDir)} (${manifest.payload.length} payload rows, ` +
    `${manifest.payload.filter((row) => row.class === 'immutable').length} immutable) — compare two builds with ` +
    `npm run verify:package -- --compare <a>/manifest.json <b>/manifest.json`,
);
console.log(
  'package: ad-hoc sealed (ADR-0008) — not Developer ID, not notarized; Gatekeeper rejection is expected. ' +
    'The verify-then-spawn TOCTOU window is an accepted residual until a signed-bundle lane.',
);

// ——— helpers ———

function cliValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv.at(index + 1);
}

function run(name, command, args, cwd, timeout = 10 * 60_000) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`${name}: timed out after ${timeout} ms`));
    }, timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) done();
      else fail(new Error(`${name}: exited with ${code}`));
    });
  }).catch((error) => {
    console.error(`package: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

async function soleArtifact(dir, suffix, what) {
  if (!existsSync(dir)) {
    console.error(`package: ${what} — output directory missing (${dir})`);
    process.exit(1);
  }
  const matches = (await readdir(dir)).filter((name) => name.endsWith(suffix));
  if (matches.length !== 1) {
    console.error(
      `package: expected exactly one ${what} under ${dir}, found ${JSON.stringify(matches)}`,
    );
    process.exit(1);
  }
  return join(dir, matches[0]);
}

async function assertNoForbiddenArtifacts(dir) {
  const forbidden = await findForbiddenArtifacts(dir);
  if (forbidden.length > 0) {
    console.error(
      `package: forbidden artifacts produced (ADR-0008 non-goals): ${JSON.stringify(forbidden)}`,
    );
    process.exit(1);
  }
}

async function readVersion() {
  const pkg = JSON.parse(await readFile(join(DESKTOP, 'package.json'), 'utf8'));
  return String(pkg.version);
}

async function gitCommit() {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ROOT });
  return stdout.trim();
}
