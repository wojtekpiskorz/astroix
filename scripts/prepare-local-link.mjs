import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Publish-shaped local link (#123): the e2e fixture consumes the integration
// through `.astroix-local/` — a staging dir holding ONLY the publish surface
// (dist, package.json, README, LICENSE) — instead of `file:../..`. The `file:`
// protocol copies the linked directory verbatim, so pointing it at the repo
// root copied the whole checkout into node_modules, where the nested
// e2e/fixture/node_modules chained again through bun's `.old-*` replacement
// artifacts (10 levels, 316M). This gate runs before the fixture dev server
// boots: build if stale, sync the surface, refresh the installed copy, and
// verify the link stayed publish-shaped.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const staging = join(root, '.astroix-local');
const fixture = join(root, 'e2e', 'fixture');
const installed = join(fixture, 'node_modules', '@wojciechpiskorz', 'astroix');

// exactly what `files: ["dist"]` + the npm defaults allow into a tarball
const PUBLISH_SURFACE = ['dist', 'package.json', 'README.md', 'LICENSE'];
// repo-only dirs a publish-shaped copy must never carry; shared by the shape
// predicate and its diagnostic so the two cannot drift
const FORBIDDEN_DIRS = ['src', 'e2e'];
// dist is the load-bearing surface for the freshness comparison; the staging
// package.json is byte-identical to the root one, so dist bytes decide
const BUILD_INPUTS = ['tsup.config.ts', 'vite.chrome.config.ts', 'package.json'];
const BUILD_OUTPUTS = ['dist/index.js', 'dist/chrome.js'];

const run = (command, cwd) => execSync(command, { cwd, stdio: 'inherit' });

function walkFiles(dir) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    // npm installs a directory `file:` dep as a single symlink into the
    // staging dir — classify through the link (statSync follows it), never
    // by the dirent type, or every linked file looks like neither file nor
    // dir and the installed tree hashes as empty.
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

/** A publish-shaped copy carries dist + manifest and never the repo itself. */
function isPublishShaped(dir) {
  return (
    !FORBIDDEN_DIRS.some((name) => existsSync(join(dir, name))) &&
    existsSync(join(dir, 'package.json')) &&
    existsSync(join(dir, 'dist'))
  );
}

function assertPublishShape(dir, label) {
  if (!isPublishShaped(dir)) {
    const forbidden = FORBIDDEN_DIRS.filter((name) => existsSync(join(dir, name)));
    throw new Error(
      `[astroix] ${label} at ${dir} is not publish-shaped` +
        (forbidden.length > 0
          ? ` (contains ${forbidden.join(', ')})`
          : ' (missing package.json/dist)') +
        ' — the local link regressed to a full-repo copy; see scripts/prepare-local-link.mjs (#123).',
    );
  }
}

// 1. Build gate: dist must exist and postdate every build input, so a stale
// dist can never silently serve the fixture (the link copies at install
// time — freshness is decided here, before the copy is made).
// statSync throws loudly when src/ or a build config is missing
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

// 2. Sync the publish surface into the staging dir (always: a full re-copy
// of ~2 MB beats reasoning about partial staleness between dist and meta).
rmSync(staging, { recursive: true, force: true });
for (const name of PUBLISH_SURFACE) {
  cpSync(join(root, name), join(staging, name), { recursive: true });
}
assertPublishShape(staging, 'staging dir');

// 3. Refresh the installed copy. npm links a directory `file:` dep as one
// symlink into the staging dir (verified: both `npm ci` and `npm install`
// materialize `node_modules/@wojciechpiskorz/astroix ->
// ../../../../.astroix-local`), so a re-sync is already live and the digest
// below only fires on a cold checkout (first install) or a regressed copy.
// The digest stays content-based so any plain-copy layout a future npm
// ships refreshes too. The lockfile guard is `npm ci` in CI: it hard-fails
// a manifest/lock drift, while a local `npm install` re-reifies the ideal
// tree from the lock and needs none of the lockfile gymnastics the tarball
// lane has (prepare-pack-fixture.mjs).
const stagedDist = treeHash(join(staging, 'dist'));
const installedDist = treeHash(join(installed, 'dist'));
// Shape arm (#152): a regressed copy (pre-#123 full-repo residue) must
// self-heal on the next boot even when its dist still hashes equal — the
// digest alone is blind to foreign dirs. An install re-reifies the lock's
// ideal tree and evicts whatever the source does not carry (verified:
// planted src/ + loose files vanish) — no rmSync needed.
const digestStale = stagedDist !== installedDist;
const shapeBroken = !isPublishShaped(installed);
if (digestStale || shapeBroken) {
  const triggers = [
    ...(digestStale ? ['staged dist differs from the installed copy'] : []),
    ...(shapeBroken ? ['installed copy is not publish-shaped'] : []),
  ];
  console.log(`[astroix] ${triggers.join('; ')} — npm install in e2e/fixture`);
  run('npm install', fixture);
}

// 4. Guard: whatever sits in the fixture's node_modules must be
// publish-shaped — this is what fails loudly if the link ever regresses.
assertPublishShape(installed, 'installed fixture copy');
