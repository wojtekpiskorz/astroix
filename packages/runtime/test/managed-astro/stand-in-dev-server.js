import { appendFileSync, existsSync, watch, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';

/**
 * The #231 supervision-lane stand-in dev server: a real child owning a
 * real loopback socket — `serve` answers HTTP 200 (readiness), `hang`
 * accepts TCP and never answers (a never-ready server for the
 * cancel/timeout lanes), and the TERM knobs give the escalation ladder
 * something real to climb (ignored or delayed SIGTERM). It exists to
 * prove SUPERVISION contracts; the real managed dev server's own
 * behavior is E1's certified `runManagedDevServer` observation.
 */

const config = JSON.parse(process.argv[2] ?? '{}');

function marker(name) {
  // Nanosecond stamps: CLOCK_MONOTONIC is comparable across processes, so
  // close-sequence ordering assertions never race on millisecond ties.
  appendFileSync(
    join(config.markerDir, `${name}.marker`),
    `${Date.now()} ${process.hrtime.bigint()}\n`,
    { mode: 0o600 },
  );
}

if (config.snapshotPath) {
  writeFileSync(
    config.snapshotPath,
    JSON.stringify({ argv: process.argv, cwd: process.cwd(), env: process.env }, null, 2),
  );
}

marker('astro-boot');
process.on('exit', () => marker('astro-exit'));

process.on('SIGTERM', () => {
  marker('astro-term-received');
  if (config.ignoreTerm) return; // the escalation case: only SIGKILL reaches it
  if (typeof config.termDelayMs === 'number') {
    setTimeout(() => process.exit(0), config.termDelayMs);
    return;
  }
  process.exit(0);
});

if (config.controlDir) {
  watch(config.controlDir, (_event, filename) => {
    if (filename === 'crash' && existsSync(join(config.controlDir, 'crash'))) {
      process.exit(1);
    }
  });
}

const server =
  config.mode === 'hang'
    ? createNetServer(() => {
        // accepted and never answered — a probe fetch hangs until its socket aborts
      })
    : createHttpServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('astroix stand-in dev server');
      });

server.listen(config.port, '127.0.0.1', () => marker('astro-listening'));
