import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One-command manual-smoke environment: install everything, build the package
 * (node dist + chrome bundle), refresh the fixture's `file:../..` link and
 * boot the dev server on :4312. Then walk docs/manual-smoke.md.
 *
 * The fixture refresh (`bun install` over the `file:../..` dependency) makes
 * bun recopy the whole checkout and can sit SILENT for a minute-plus — it is
 * skipped when the installed copy of dist/ is already byte-identical, so
 * repeat runs boot in seconds.
 */
const run = (command, options = {}) => execSync(command, { stdio: 'inherit', ...options });

const distHash = (dir) => {
  if (!existsSync(dir)) return null;
  const hash = createHash('sha256');
  for (const name of readdirSync(dir).sort()) {
    hash.update(name);
    hash.update(readFileSync(join(dir, name)));
  }
  return hash.digest('hex');
};

console.log('→ installing root dependencies');
run('bun install');

console.log('→ building the package (node dist + chrome bundle)');
run('bun run build');

const fixtureReady =
  existsSync('e2e/fixture/node_modules/astro') &&
  distHash('dist') === distHash('e2e/fixture/node_modules/@wojciechpiskorz/astroix/dist');

if (fixtureReady) {
  console.log('→ fixture already serves this exact build — skipping the dependency refresh');
} else {
  console.log('→ refreshing the e2e fixture dependency (bun recopies the whole checkout;');
  console.log('   this step is silent and can take a minute or two the first time)');
  run('bun install', { cwd: 'e2e/fixture' });
}

console.log();
console.log('Smoke environment ready — the dev server is starting.');
console.log('  open:    http://localhost:4312/');
console.log('  follow:  docs/manual-smoke.md (7 steps)');
console.log('  stop:    Ctrl+C');
console.log();

run('bun run dev', { cwd: 'e2e/fixture' });
