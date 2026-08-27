import { execSync } from 'node:child_process';

/**
 * One-command manual-smoke environment: install everything, build the package
 * (node dist + chrome bundle), refresh the fixture's `file:../..` link and
 * boot the dev server on :4312. Then walk docs/manual-smoke.md.
 */
const run = (command, options = {}) => execSync(command, { stdio: 'inherit', ...options });

console.log('→ installing root dependencies');
run('bun install');

console.log('→ building the package (node dist + chrome bundle)');
run('bun run build');

console.log('→ refreshing the e2e fixture dependency');
run('bun install', { cwd: 'e2e/fixture' });

console.log();
console.log('Smoke environment ready — the dev server is starting.');
console.log('  open:    http://localhost:4312/');
console.log('  follow:  docs/manual-smoke.md (7 steps)');
console.log('  stop:    Ctrl+C');
console.log();

run('bun run dev', { cwd: 'e2e/fixture' });
