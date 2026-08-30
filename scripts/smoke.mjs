import { execSync } from 'node:child_process';
import { createConnection } from 'node:net';

const SMOKE_PORT = 4312;

/** True when something is already listening on the port. */
const isPortOpen = (port) =>
  new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(false);
    });
  });

/**
 * One-command manual-smoke environment: install everything, build the package
 * (node dist + chrome bundle), stage the publish-shaped local link (#123) and
 * boot the dev server on :4312. Then walk docs/manual-smoke.md.
 */
const run = (command, options = {}) => execSync(command, { stdio: 'inherit', ...options });

if (await isPortOpen(SMOKE_PORT)) {
  console.error(`astroix smoke: port ${SMOKE_PORT} is already occupied — a dev server is there.`);
  console.error('  kill it:   lsof -ti :4312 | xargs kill');
  console.error(
    '  tracked servers can also be stopped with: cd e2e/fixture && bunx astro dev stop',
  );
  console.error('  or simply keep using the running server.');
  process.exit(1);
}

console.log('→ installing root dependencies');
run('bun install');

console.log('→ building the package (node dist + chrome bundle)');
run('bun run build');

console.log('→ staging the publish-shaped local link for the fixture');
run('bun run prepare-local');

console.log();
console.log('Smoke environment ready — the dev server is starting.');
console.log('  open:    http://localhost:4312/');
console.log('  follow:  docs/manual-smoke.md (7 steps)');
console.log('  stop:    Ctrl+C');
console.log();

run('bun run dev', { cwd: 'e2e/fixture' });
