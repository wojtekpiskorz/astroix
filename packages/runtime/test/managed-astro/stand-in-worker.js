import { appendFileSync, existsSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The #231 supervision-lane stand-in worker child: a real forked child
 * speaking E6's worker wire subset over its real IPC channel — it answers
 * the supervisor's readiness probe, honors the stop control with the
 * close report, and exits 0. The knobs exist to prove SUPERVISION
 * contracts (boot failure, crash-on-control, stop-hang with ignored
 * TERM, an incomplete own-report, and the awaitAstroListening close
 * rendezvous), never worker behavior — the real boot-and-serve contract
 * is E6's process lane (#230).
 *
 * The #308 wire-facet knobs: inspections answer with the request's own
 * wire id as the revision (correlation provable end-to-end — the probe
 * keeps id 0), `failInspectIds` answers structured failures for chosen
 * consumer ids, `hangInspectIds` never answers (a crash settles the
 * in-flight dispatch), and the `emit-event` control file publishes one
 * public event frame.
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

const failInspectIds = Array.isArray(config.behaviors?.failInspectIds)
  ? config.behaviors.failInspectIds
  : [];
const hangInspectIds = Array.isArray(config.behaviors?.hangInspectIds)
  ? config.behaviors.hangInspectIds
  : [];

if (config.controlDir) {
  watch(config.controlDir, (_event, filename) => {
    if (filename === 'crash' && existsSync(join(config.controlDir, 'crash'))) {
      process.exit(70);
    }
    if (filename === 'emit-event' && existsSync(join(config.controlDir, 'emit-event'))) {
      process.send({
        type: 'event',
        event: { type: 'invalidation', families: ['styles'], revision: 2 },
      });
    }
  });
}

process.on('message', (message) => {
  if (message?.type === 'inspect') {
    // probeFail: the worker is alive but its project inspection failed —
    // E6's ok:false failure answer, byte-shaped like the real wire.
    if (config.behaviors?.probeFail) {
      process.send({
        type: 'inspect-result',
        id: message.id,
        ok: false,
        failure: {
          code: 'inspection-failed',
          message: 'the project inspection failed unexpectedly',
          adapterCode: null,
        },
      });
      return;
    }
    // hangInspectIds: receipt is proven, the answer never comes — a
    // consumer crash-settlement leg settles the in-flight dispatch.
    if (hangInspectIds.includes(message.id)) {
      marker('worker-inspect-hang');
      return;
    }
    if (failInspectIds.includes(message.id)) {
      process.send({
        type: 'inspect-result',
        id: message.id,
        ok: false,
        failure: {
          code: 'inspection-failed',
          message: 'the project inspection failed unexpectedly',
          adapterCode: null,
        },
      });
      return;
    }
    // The correlated answer: the wire id rides the revision, so a
    // consumer leg proves the id correlation end-to-end (the probe's id
    // is always 0; consumer traffic is ≥ 1).
    const kind = typeof message.request?.kind === 'string' ? message.request.kind : 'project';
    process.send({
      type: 'inspect-result',
      id: message.id,
      ok: true,
      result: {
        kind,
        revision: message.id,
        payload: { certified: { astro: '7.2.10', vite: '8.2.2' } },
      },
    });
    return;
  }
  if (message?.type === 'stop') {
    marker('worker-stop-received');
    if (config.behaviors?.hangStop) return;
    const finish = () => {
      process.send({
        type: 'closed',
        report: config.behaviors?.incompleteReport ? INCOMPLETE_REPORT : COMPLETE_REPORT,
      });
      process.exit(0);
    };
    // awaitAstroListening: the startup-deadline leg's boot-race rendezvous
    // (#322). The supervisor TERMs the dev server only after this close
    // report, and the sibling stamps astro-listening strictly AFTER it
    // registered its SIGTERM/exit handlers — so holding the report until
    // that marker appears makes the dev server's clean exit (and its
    // astro-exit stamp) a causal consequence of the supervisor's signal,
    // never a race between the startup deadline's SIGTERM and the
    // sibling's node boot under load.
    if (!config.behaviors?.awaitAstroListening) {
      finish();
      return;
    }
    const astroListening = join(config.markerDir, 'astro-listening.marker');
    const poll = () => {
      if (existsSync(astroListening)) {
        finish();
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  }
});
