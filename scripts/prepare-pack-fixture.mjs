import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'e2e', 'pack-fixture');
const tarballName = 'astroix-pack.tgz';

// npm-pack smoke lane (ADR-0001): build the exact shipped artifact, pack it,
// and install it into the pack fixture under a stable name so its
// package.json (`file:./astroix-pack.tgz`) needs no per-run mutation.
execSync('npm run build', { cwd: root, stdio: 'inherit' });
rmSync(join(root, tarballName), { force: true });
const packed = execSync('npm pack --json', { cwd: root, encoding: 'utf8' });
const fileName = JSON.parse(packed)[0]?.filename;
if (typeof fileName !== 'string' || !fileName.endsWith('.tgz')) {
  throw new Error(`npm pack produced no tarball: ${packed}`);
}
cpSync(join(root, fileName), join(fixture, tarballName));
rmSync(join(root, fileName));
if (!existsSync(join(fixture, tarballName))) {
  throw new Error('tarball copy failed');
}
// a same-named file: tarball does not re-install on its own: npm's lockfile
// pins the recorded resolution and its cache serves the old extraction —
// drop both the installed package and the lock so the fresh artifact always
// lands; both are no-ops on a clean CI checkout
rmSync(join(fixture, 'node_modules', '@wojciechpiskorz'), { recursive: true, force: true });
rmSync(join(fixture, 'package-lock.json'), { force: true });
execSync('npm install', { cwd: fixture, stdio: 'inherit' });
console.log(`pack fixture ready (${tarballName} = ${fileName})`);
