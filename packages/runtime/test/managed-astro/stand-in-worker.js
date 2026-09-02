import { appendFileSync, existsSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The #231 supervision-lane stand-in worker child: a real forked child
 * speaking E6's worker wire subset over its real IPC channel — it answers
 * the supervisor's readiness probe, honors the stop control with the
 * close report, and exits 0. The knobs exist to prove SUPERVISION
 * contracts (boot failure, crash-on-control, stop-hang with ignored
 * TERM, an incomplete own-report), never worker behavior — the real
 * boot-and-serve contract is E6's process lane (#230).
 */

const config = JSON.parse(process.argv[2] ?? '{}');

const COMPLETE_REPORT = {
  reason: 'stopped',
  outcome: 'complete',
  failures: [],
  accounting: { inFlightSettled: true, unsubscribed: true, planeClosed: true },
};
const INCOMPLETE_REPORT = {
  reason: 'stopped',
  outcome: 'incomplete',
  failures: ['in-flight-drain'],
  accounting: { inFlightSettled: false, unsubscribed: true, planeClosed: true },
};

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

if (config.behaviors?.bootFail) {
  process.exit(74);
}

marker('worker-boot');
process.on('exit', () => marker('worker-exit'));

if (config.behaviors?.hangStop) {
  // The pathological worker: never answers the stop, ignores SIGTERM — only the KILL ladder reaches it.
  process.on('SIGTERM', () => marker('worker-term-ignored'));
}

if (config.controlDir) {
  watch(config.controlDir, (_event, filename) => {
    if (filename === 'crash' && existsSync(join(config.controlDir, 'crash'))) {
      process.exit(70);
    }
  });
}

process.on('message', (message) => {
  if (message?.type === 'inspect') {
    process.send({
      type: 'inspect-result',
      id: message.id,
      ok: true,
      result: {
        kind: 'project',
        revision: 1,
        payload: { certified: { astro: '7.2.10', vite: '8.2.2' } },
      },
    });
    return;
  }
  if (message?.type === 'stop') {
    marker('worker-stop-received');
    if (config.behaviors?.hangStop) return;
    process.send({
      type: 'closed',
      report: config.behaviors?.incompleteReport ? INCOMPLETE_REPORT : COMPLETE_REPORT,
    });
    process.exit(0);
  }
});
