import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-mode staging (#150): the src-fixture consumes the integration through
// `.astroix-local-src/` — dist copied byte-for-byte (the node side always runs
// from `dist/index.js`) plus `src` as a symlink to the repo's own `src/`, so
// chrome edits stay live in staging and the dev server serves them as source
// (ADR-0001 source mode: fast-refresh, the HMR loop this lane restores). Kept
// a separate script from prepare-local-link.mjs on purpose — that staging is
// publish-shaped (dist only, `src` forbidden); this one is the opposite and
// must never feed the main fixture.
//
// The `src` symlink is the realpath-vs-symlink-path edge this lane exists to
// catch (the fs.allow / plugin-react include regexes are built from
// clientEntryPath through this layout). It holds together (#150, re-verified
// under npm): npm links the whole staging dir into the fixture's
// node_modules as one symlink, so the symlinked `src` never needs to be
// materialized anywhere — node realpath-resolves the running `dist/index.js`
// back to this staging, where the symlink sits; the detection then realpaths
// through it to the repo's own `src/`, which is what every downstream
// consumer (the /@fs URL, fs.allow, the include regex) operates on. If that
// ever breaks (npm or node changes either resolution behavior), the honest
// fallback is a plain copy here — and ADR-0001 must say which one ships.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const staging = join(root, '.astroix-local-src');
const fixture = join(root, 'e2e', 'src-fixture');
const installed = join(fixture, 'node_modules', '@wojciechpiskorz', 'astroix');

// publish meta + dist bytes; `src` joins below as the symlink — NEVER `e2e/`
// (the #123 recursion this staging shape exists to avoid)
const STAGED_SURFACE = ['dist', 'package.json', 'README.md', 'LICENSE'];
const BUILD_INPUTS = ['tsup.config.ts', 'vite.chrome.config.ts', 'package.json'];
const BUILD_OUTPUTS = ['dist/index.js', 'dist/chrome.js'];

const run = (command, cwd) => execSync(command, { cwd, stdio: 'inherit' });

function walkFiles(dir) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    // classify through symlinks (statSync follows), like the npm-linked
    // installed tree this walker also serves — see prepare-local-link.mjs
    const stats = statSync(path);
    if (stats.isDirectory()) files.push(...walkFiles(path));
    else if (stats.isFile()) files.push(path);
  }
  return files;
}

/** Content digest of a tree: sorted relative paths + bytes, mtimes ignored. */
function treeHash(dir) {
  if (!existsSync(dir)) return null;
  const hash = createHash('sha256');
  for (const path of walkFiles(dir).sort()) {
    hash.update(path.slice(dir.length + 1));
    hash.update(readFileSync(path));
  }
  return hash.digest('hex');
}

/**
 * Staging shape: dist + src + manifest, never the repo itself (`e2e` is the
 * recursion tripwire; `src` is required here, not forbidden — the inverse of
 * the publish-shape assert in prepare-local-link.mjs). The INSTALLED copy
 * is npm's single symlink into this staging (verified: clean install), so
 * `src` shows up through the link too — the assert stays staging-strict
 * (`requireSrc`) and installed-lenient, since the running dist realpath-
 * resolves into the staging either way.
 */
function assertShape(dir, label, { requireSrc }) {
  const required = requireSrc ? ['dist', 'src', 'package.json'] : ['dist', 'package.json'];
  const missing = required.filter((name) => !existsSync(join(dir, name)));
  if (missing.length > 0 || existsSync(join(dir, 'e2e'))) {
    throw new Error(
      `[astroix] ${label} at ${dir} is not source-mode-shaped` +
        (missing.length > 0 ? ` (missing ${missing.join(', ')})` : ' (contains e2e)') +
        ' — see scripts/prepare-src-link.mjs (#150).',
    );
  }
}

// 1. Build gate: dist must postdate every build input (same contract as the
// publish-shaped staging — a stale dist must never serve the src fixture).
const inputMtimes = walkFiles(join(root, 'src'))
  .concat(BUILD_INPUTS.map((name) => join(root, name)))
  .map((path) => statSync(path).mtimeMs);
const outputMtimes = BUILD_OUTPUTS.map((name) => {
  const path = join(root, name);
  return existsSync(path) ? statSync(path).mtimeMs : 0;
});
if (Math.max(...inputMtimes) > Math.min(...outputMtimes)) {
  console.log('[astroix] dist is stale — rebuilding (npm run build)');
  run('npm run build', root);
}

// 2. Sync: meta + dist copied fresh, then `src` symlinked at the repo's own
// source. fs.rm never follows the old symlink (it unlinks it), so the rebuild
// below can never traverse into the real src tree.
rmSync(staging, { recursive: true, force: true });
for (const name of STAGED_SURFACE) {
  cpSync(join(root, name), join(staging, name), { recursive: true });
}
// relative to the staging dir (the link's containing directory), so the
// staging always points at this checkout's src from wherever it sits
symlinkSync('../src', join(staging, 'src'), 'dir');
assertShape(staging, 'staging dir', { requireSrc: true });

// 3. Refresh the installed copy (same digest dance as the publish staging:
// npm links a dir `file:` dep as one symlink into the staging dir, so the
// symlinked `src` rides along; dist bytes decide on cold boots).
const stagedDist = treeHash(join(staging, 'dist'));
const installedDist = treeHash(join(installed, 'dist'));
if (stagedDist !== installedDist) {
  console.log(
    '[astroix] staged dist differs from the installed copy — npm install in e2e/src-fixture',
  );
  run('npm install', fixture);
}

// 4. Guard: whatever sits in the src-fixture's node_modules must carry the
// package surface and never the repo itself — fails loudly if the link ever
// regresses. (`src` lives in the staging, not here — see assertShape.)
assertShape(installed, 'installed fixture copy', { requireSrc: false });
