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
execSync('bun run build', { cwd: root, stdio: 'inherit' });
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
execSync('bun install', { cwd: fixture, stdio: 'inherit' });
console.log(`pack fixture ready (${tarballName} = ${fileName})`);
