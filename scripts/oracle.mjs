import { execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORACLE_MAIN, ORACLE_PACK, ORACLE_SRC } from '../e2e/oracle.mjs';

// Shared machinery for the disposable oracle copies (#213, ADR-0010): the
// canonical e2e/fixture is plain Astro, and each integration-era lane boots
// a generated copy that registers the retired integration through a staging
// link. Everything here is regenerate-on-setup: cleanup is rm-and-recreate,
// never git — a leaked dirty file from a previous run cannot survive.

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const canonicalFixture = join(root, 'e2e', 'fixture');
export const packInput = join(root, 'e2e', 'pack-fixture');
export const oracleMain = join(root, ORACLE_MAIN);
export const oraclePack = join(root, ORACLE_PACK);
export const oracleSrc = join(root, ORACLE_SRC);

// exactly what `files: ["dist"]` + the npm defaults allow into a tarball
const PUBLISH_SURFACE = ['dist', 'package.json', 'README.md', 'LICENSE'];
// root build inputs: the two build configs, the manifest, and the tsconfig
// (tsup's dts pass reads it — a tsconfig-only edit must trip the gate too)
const BUILD_INPUTS = ['tsup.config.ts', 'vite.chrome.config.ts', 'package.json', 'tsconfig.json'];
const BUILD_OUTPUTS = ['dist/index.js', 'dist/chrome.js'];

const run = (command, cwd) => execSync(command, { cwd, stdio: 'inherit' });

function walkFiles(dir) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    // classify through symlinks (statSync follows), like the linked
    // installed trees this walker also serves — see farmNodeModules
    const stats = statSync(path);
    if (stats.isDirectory()) files.push(...walkFiles(path));
    else if (stats.isFile()) files.push(path);
  }
  return files;
}

/**
 * One shape predicate for every staging / installed-oracle surface: required
 * present + forbidden absent, data-driven — the publish vs source-mode
 * difference is data, not code branches (the pre-#213 prepare-src-link had a
 * unified assertShape worth keeping; #213 first regressed it into three
 * near-copies, advisory round 1 folded them back).
 */
function assertShape(dir, label, shape) {
  const { required, forbidden, hint } = shape;
  const missing = required.filter((name) => !existsSync(join(dir, name)));
  const present = forbidden.filter((name) => existsSync(join(dir, name)));
  if (missing.length > 0 || present.length > 0) {
    throw new Error(
      `[astroix] ${label} at ${dir} is wrong-shaped` +
        (missing.length > 0 ? ` (missing ${missing.join(', ')})` : '') +
        (present.length > 0 ? ` (contains ${present.join(', ')})` : '') +
        ` — ${hint}`,
    );
  }
}

/** Publish shape: the tarball surface only — `src` and `e2e` never ride along. */
const PUBLISH_SHAPE = {
  required: ['package.json', 'dist'],
  forbidden: ['src', 'e2e'],
  hint: 'the local link regressed to a full-repo copy; see scripts/prepare-local-link.mjs (#123).',
};

/** Source-mode shape: the inverse — `src` is required here, never forbidden. */
const SOURCE_SHAPE = {
  required: ['dist', 'src', 'package.json'],
  forbidden: ['e2e'],
  hint: 'see scripts/prepare-src-link.mjs (#150).',
};

/** Installed-oracle link shape: package surface through the link, no repo. */
const LINK_SHAPE = {
  required: ['dist', 'package.json'],
  forbidden: ['e2e'],
  hint: 'see scripts/oracle.mjs (#213).',
};

/** Installed-oracle link shape for the source-mode staging (src rides along). */
const LINK_SOURCE_SHAPE = {
  required: ['dist', 'src', 'package.json'],
  forbidden: ['e2e'],
  hint: 'see scripts/oracle.mjs (#213).',
};

/**
 * Every file the build reads: the src tree, the root build inputs (both
 * build configs, the manifest, the tsconfig tsup's dts pass reads), and
 * every packages/<name> src tree — dist bundles through the src/core +
 * src/client re-export shims (#270, #273), so a local edit under packages/
 * must trip the gate exactly like one under src/ (advisory round 1: the
 * walk gap let both lanes boot a stale chrome with no warning). walkFiles
 * returns [] for a missing tree, so a checkout without packages/ still
 * gates on src/.
 */
function buildInputFiles() {
  const packageSrcs = existsSync(join(root, 'packages'))
    ? readdirSync(join(root, 'packages')).flatMap((name) =>
        walkFiles(join(root, 'packages', name, 'src')),
      )
    : [];
  return walkFiles(join(root, 'src'))
    .concat(BUILD_INPUTS.map((name) => join(root, name)))
    .concat(packageSrcs);
}

/** dist is stale when any build input postdates the oldest build output. */
function distIsStale() {
  const inputMtimes = buildInputFiles().map((path) => statSync(path).mtimeMs);
  const outputMtimes = BUILD_OUTPUTS.map((name) => {
    const path = join(root, name);
    return existsSync(path) ? statSync(path).mtimeMs : 0;
  });
  return Math.max(...inputMtimes) > Math.min(...outputMtimes);
}

// Single-flight guard for the shared build gate: playwright boots the lanes'
// webServers concurrently, and both farmed lanes run this gate — a stale dist
// must trigger exactly ONE `npm run build`, never two writing dist/ at the
// same time. The lock is crash-safe: a builder that dies leaves the file
// behind, so a waiter checks the holder's pid for life and caps the lock's
// age — a crashed builder never wedges the next run.
const BUILD_LOCK = join(root, '.astroix-build.lock');
const BUILD_LOCK_STALE_MS = 10 * 60_000;
const LOCK_POLL_MS = 500;

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** True when a pid is alive (EPERM = alive under another owner). */
function pidIsLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireBuildLock() {
  for (;;) {
    try {
      writeFileSync(BUILD_LOCK, String(process.pid), { flag: 'wx' });
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let holder = 0;
    let age = 0;
    try {
      holder = Number.parseInt(readFileSync(BUILD_LOCK, 'utf8').trim(), 10);
      age = Date.now() - statSync(BUILD_LOCK).mtimeMs;
    } catch {
      // the lock vanished (or was replaced) between the failed create and
      // this read — the exact release race this loop absorbs: retry the
      // create instead of dying on the now-missing file. Poll-paced so a
      // persistently unreadable lock cannot hot-spin.
      sleepSync(LOCK_POLL_MS);
      continue;
    }
    const live = Number.isInteger(holder) && holder > 0 && pidIsLive(holder);
    if (!live || age > BUILD_LOCK_STALE_MS) {
      // takeover: dead holder, or a lock aged past any honest build. The
      // tiny rm/create race with a third process degrades to today's
      // behavior (one redundant build), never to a wedge.
      try {
        rmSync(BUILD_LOCK, { force: true });
      } catch {
        // someone replaced it already — loop and re-evaluate
      }
      console.log(
        `[astroix] taking over the stale build lock (holder pid ${holder}, live: ${live}, age ${Math.round(age / 1000)}s)`,
      );
      continue;
    }
    sleepSync(LOCK_POLL_MS);
  }
}

/**
 * Build gate: dist must exist and postdate every build input, so a stale
 * dist can never silently serve an oracle (the copies link at prep time —
 * freshness is decided here, before the link is made). statSync throws
 * loudly when a build input is missing. Stale → one serialized build: the
 * waiter re-checks freshness inside the lock and skips when the other lane
 * already rebuilt.
 */
export function ensureFreshDist() {
  if (!distIsStale()) return;
  acquireBuildLock();
  try {
    if (distIsStale()) {
      console.log('[astroix] dist is stale — rebuilding (npm run build)');
      run('npm run build', root);
    }
  } finally {
    rmSync(BUILD_LOCK, { force: true });
  }
}

/**
 * Sync a staging dir (`.astroix-local` publish-shaped, or
 * `.astroix-local-src` with `src` symlinked for source mode) from the repo
 * surface. Always a full re-copy: ~2 MB beats reasoning about partial
 * staleness between dist and meta. fs.rm never follows the old `src`
 * symlink (it unlinks it), so the rebuild can never traverse into src/.
 */
export function syncStaging(staging, { withSrcSymlink = false } = {}) {
  rmSync(staging, { recursive: true, force: true });
  for (const name of PUBLISH_SURFACE) {
    cpSync(join(root, name), join(staging, name), { recursive: true });
  }
  if (withSrcSymlink) {
    // relative to the staging dir, so the link always points at this
    // checkout's src from wherever the staging sits
    symlinkSync('../src', join(staging, 'src'), 'dir');
    assertShape(staging, 'staging dir', SOURCE_SHAPE);
  } else {
    assertShape(staging, 'staging dir', PUBLISH_SHAPE);
  }
}

/**
 * Cold-checkout guard: the farmed oracles read the canonical fixture's
 * install, so a missing one is installed here (CI's `npm ci` in
 * e2e/fixture satisfies this before the lanes ever run; only a bare local
 * checkout reaches the install).
 */
export function ensurePlainFixtureInstall() {
  if (!existsSync(join(canonicalFixture, 'node_modules', 'astro'))) {
    console.log('[astroix] e2e/fixture is not installed — npm install (cold checkout)');
    run('npm install', canonicalFixture);
  }
}

/**
 * The pre-#213 seam: older checkouts still carry an installed
 * @wojciechpiskorz/astroix inside the canonical fixture's node_modules from
 * when the fixture itself consumed the staging. No oracle reads it — the
 * farm links the staging directly — so it is evicted deterministically.
 */
export function evictStaleFixtureIntegration() {
  const stale = join(canonicalFixture, 'node_modules', '@wojciechpiskorz');
  if (existsSync(stale)) {
    console.log('[astroix] removing the stale integration install from e2e/fixture (#213)');
    rmSync(stale, { recursive: true, force: true });
  }
}

/**
 * Deterministic cleanup with warm derived caches (#213): the first-party
 * bytes (src, config, manifest, the node_modules farm) regenerate on every
 * pass; two DERIVED caches persist across runs — vite's optimizer cache
 * (node_modules/.vite) and astro's sync state (.astro, the content-layer
 * data store). That is the exact parity the retired fixtures had when their
 * installs and stores lived on between runs, and it keeps the cold-boot
 * windows of the #158/#129 contention family shut: a from-scratch oracle
 * boots the whole chrome and re-syncs all content mid-suite, doubling the
 * run time and opening every boot race the specs' budgets were never sized
 * for. Nothing kept is asserted state — rm the oracle dir and the next pass
 * rebuilds all of it; cleanup never touches git.
 */
export function resetOracle(dir) {
  mkdirSync(dir, { recursive: true });
  rmSync(join(dir, 'src'), { recursive: true, force: true });
  const modules = join(dir, 'node_modules');
  const viteCache = join(modules, '.vite');
  const parking = join(dir, '.vite-parked');
  rmSync(parking, { recursive: true, force: true });
  if (existsSync(viteCache)) {
    // park the cache beside node_modules (same filesystem, one rename each
    // way), rebuild the farm, restore — a crash between the two leaves the
    // parked copy for the next pass to sweep
    renameSync(viteCache, parking);
    rmSync(modules, { recursive: true, force: true });
    mkdirSync(modules, { recursive: true });
    renameSync(parking, viteCache);
  } else {
    rmSync(modules, { recursive: true, force: true });
  }
}

/**
 * Partial reset for oracles whose node_modules persists across runs (the
 * pack lane's tarball install): only the generated-from-input surface goes,
 * never the install cache. Deterministic like resetOracle — regenerate the
 * sources, never `git restore`.
 */
export function resetOracleSources(dir) {
  rmSync(join(dir, 'src'), { recursive: true, force: true });
}

/** The generated config every oracle shares: plain Astro plus astroix(). */
export const ASTROIX_ORACLE_CONFIG = `import astroix from '@wojciechpiskorz/astroix';
import { defineConfig } from 'astro/config';

// Disposable oracle copy generated by the prepare scripts (#213, ADR-0010):
// the canonical fixture stays plain Astro — only this generated copy
// registers the retired integration.
export default defineConfig({
  integrations: [astroix()],
});
`;

/** Write the generated config + manifest an oracle boots from. */
export function writeOracleMeta(dir, { name, scripts, dependencies }) {
  writeFileSync(join(dir, 'astro.config.mjs'), ASTROIX_ORACLE_CONFIG);
  const manifest = { name, private: true, type: 'module', scripts };
  if (dependencies) manifest.dependencies = dependencies;
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * The oracle's node_modules: a symlink-per-entry view of the canonical
 * fixture's install plus `@wojciechpiskorz/astroix` linked straight at the
 * staging dir — the exact layout npm's directory `file:` linking
 * materializes (verified #123/#150: one symlink into the staging), so dist
 * realpaths, peer resolution and the source-mode detection all behave
 * identically while the oracle never pays (or waits on) its own astro
 * install. The scoped dir is never farmed: a stale fixture-local copy must
 * not leak through, and the link below owns it exclusively. Relative link
 * entries inside `.bin` resolve at their target, so bin scripts run
 * against the canonical tree.
 */
export function farmNodeModules(oracleDir, stagingDir) {
  const source = join(canonicalFixture, 'node_modules');
  const dest = join(oracleDir, 'node_modules');
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(source)) {
    // never farmed: the scoped dir is linked below, and `.vite` is vite's
    // per-server optimizer cache — a dogfood `npm run dev` in the canonical
    // fixture creates one in its node_modules, and linking it here would
    // make two dev servers share a single cache (observed: the src lane's
    // canvas silently stopped reloading after main-lane traffic). Each
    // oracle gets its own real `.vite` inside its own node_modules dir.
    if (entry === '@wojciechpiskorz' || entry === '.vite') continue;
    symlinkSync(join(source, entry), join(dest, entry));
  }
  linkStagedIntegration(oracleDir, stagingDir);
}

/** Link `@wojciechpiskorz/astroix` at the staging dir (relative, like npm). */
export function linkStagedIntegration(oracleDir, stagingDir) {
  const scope = join(oracleDir, 'node_modules', '@wojciechpiskorz');
  mkdirSync(scope, { recursive: true });
  const link = join(scope, 'astroix');
  rmSync(link, { force: true });
  symlinkSync(relative(scope, stagingDir), link);
}

/**
 * Guard: the oracle's installed integration must carry the package surface
 * through the link — `src` rides along only for the source-mode staging
 * (requireSrc) — and never the repo itself.
 */
export function assertOracleLink(oracleDir, { requireSrc = false } = {}) {
  const installed = join(oracleDir, 'node_modules', '@wojciechpiskorz', 'astroix');
  assertShape(installed, 'oracle link', requireSrc ? LINK_SOURCE_SHAPE : LINK_SHAPE);
}

/** Copy the canonical content bytes into a fresh oracle (verbatim, tsconfig included when the input carries one). */
export function copyOracleSources(oracleDir, sourceDir) {
  cpSync(join(sourceDir, 'src'), join(oracleDir, 'src'), { recursive: true });
  const tsconfig = join(sourceDir, 'tsconfig.json');
  if (existsSync(tsconfig)) {
    cpSync(tsconfig, join(oracleDir, 'tsconfig.json'));
  }
}
