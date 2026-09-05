import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { minimalChildEnv } from '../../project-plane/supervision/exact-child.ts';
import {
  createProjectPlaneSupervisor,
  type PlaneSupervisorOptions,
  type ProjectPlaneSupervisor,
  workerSpawnPlan,
} from '../../project-plane/supervision/plane-supervisor.ts';
import { WorkerRejectionError } from '../../project-plane/worker/worker-failure.ts';
import { cleanupScratch, freePort, makeScratch } from './lane-harness.ts';

// @vitest-environment node — spawns real children with real signals and sockets; no DOM.
/**
 * The #231 supervision process lane: the plane supervisor over REAL child
 * processes — the stand-in worker (E6's wire subset) and the stand-in dev
 * server (a real loopback socket) spawned through the same exact-child
 * spawn path production uses. Crash is terminal and never auto-restarts;
 * the crash law reaps the surviving sibling in the terminal transition's
 * own tick — the managed dev server on a worker crash (#365, never left
 * alive holding Astro's dev lock), the worker on a managed-astro crash
 * (#402, the mirror: never left waiting out the stop-bound → TERM-grace
 * → KILL ladder a torn-down supervisor would truncate into an orphan);
 * the graceful stop runs the ordered close (worker internals, sockets,
 * then terminate+reap both exact children); escalation and reap bounds
 * are exercised against children that really ignore or delay SIGTERM.
 */

const STAND_IN_WORKER = fileURLToPath(new URL('./stand-in-worker.js', import.meta.url));
const STAND_IN_DEV_SERVER = fileURLToPath(new URL('./stand-in-dev-server.js', import.meta.url));

interface Lane {
  readonly supervisor: ProjectPlaneSupervisor;
  readonly markerDir: string;
  readonly workerControlDir: string;
  readonly astroControlDir: string;
  readonly scratch: string;
  /** The loopback port the lane's dev-server child serves on — the cross-process death witness. */
  readonly port: number;
}

const lanes: Lane[] = [];

afterEach(async () => {
  await Promise.allSettled(lanes.splice(0).map((lane) => lane.supervisor.stop()));
  await cleanupScratch();
});

interface LaneConfig {
  workerBehaviors?: Record<string, unknown>;
  devServer?: Record<string, unknown>;
  bounds?: Partial<
    Pick<
      PlaneSupervisorOptions,
      'startupTimeoutMs' | 'stopTimeoutMs' | 'termGraceMs' | 'killReapMs' | 'probeIntervalMs'
    >
  >;
  /** Overrides the whole environment both children spawn with (the spawn-discipline test). */
  env?: Record<string, string>;
  /** Overrides the project root both children run in (the shell-metacharacter test). */
  cwd?: string;
  workerSnapshotPath?: string;
  astroSnapshotPath?: string;
}

async function startLane(config: LaneConfig = {}): Promise<Lane> {
  const scratch = await makeScratch('astroix-sup-');
  const markerDir = join(scratch, 'markers');
  const workerControlDir = join(scratch, 'worker-control');
  const astroControlDir = join(scratch, 'astro-control');
  await Promise.all([mkdir(markerDir), mkdir(workerControlDir), mkdir(astroControlDir)]);
  const cwd = config.cwd ?? scratch;
  const env = config.env ?? minimalChildEnv(process.env);
  const port = await freePort();
  const workerArgument = JSON.stringify({
    markerDir,
    controlDir: workerControlDir,
    behaviors: config.workerBehaviors ?? {},
    ...(config.workerSnapshotPath ? { snapshotPath: config.workerSnapshotPath } : {}),
  });
  const devServerArgument = JSON.stringify({
    markerDir,
    controlDir: astroControlDir,
    port,
    ...config.devServer,
    ...(config.astroSnapshotPath ? { snapshotPath: config.astroSnapshotPath } : {}),
  });
  const supervisor = createProjectPlaneSupervisor({
    worker: {
      executable: process.execPath,
      argv: [STAND_IN_WORKER, workerArgument],
      cwd,
      env,
      ipc: true,
      execArgv: [],
    },
    managedAstro: {
      executable: process.execPath,
      argv: [STAND_IN_DEV_SERVER, devServerArgument],
      cwd,
      env,
      ipc: false,
    },
    devServerPort: port,
    startupTimeoutMs: 3000,
    stopTimeoutMs: 600,
    termGraceMs: 200,
    killReapMs: 200,
    probeIntervalMs: 15,
    ...config.bounds,
  });
  const lane: Lane = {
    supervisor,
    markerDir,
    workerControlDir,
    astroControlDir,
    scratch,
    port,
  };
  lanes.push(lane);
  return lane;
}

async function markerStamps(markerDir: string, name: string): Promise<bigint[]> {
  try {
    const contents = await readFile(join(markerDir, `${name}.marker`), 'utf8');
    return contents
      .trim()
      .split('\n')
      .map((line) => BigInt(line.split(' ')[1] ?? '0'));
  } catch {
    return [];
  }
}

function crash(controlDir: string): Promise<void> {
  return writeFile(join(controlDir, 'crash'), '', { mode: 0o600 });
}

/**
 * True when nothing answers on the lane's dev-server port — the
 * cross-process death witness (#365): a killed sibling's listener dies
 * with its process (the kernel closes the sockets at process death),
 * so a refused connection proves the dev server dead independently of
 * anything the supervisor reports.
 */
async function portRefused(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const settle = (refused: boolean): void => {
      socket.destroy();
      resolve(refused);
    };
    socket.once('error', () => settle(true));
    socket.once('connect', () => settle(false));
  });
}

/** Awaits one stamp of a marker the stand-in child writes (receipt proof across processes). */
async function waitForMarker(markerDir: string, name: string): Promise<void> {
  await vi.waitFor(async () => {
    if ((await markerStamps(markerDir, name)).length === 0) {
      throw new Error(`waiting for the ${name} marker`);
    }
  });
}

/** The facet-dispatch rejection assertion: the E6 species carrying its code. */
async function facetRejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WorkerRejectionError);
    return (error as WorkerRejectionError).failure.code;
  }
  throw new Error('the facet dispatch settled unexpectedly');
}

function rejectedReady(
  supervisor: ProjectPlaneSupervisor,
): Promise<{ code: string; message: string }> {
  return supervisor.ready.then(
    () => {
      throw new Error('ready resolved unexpectedly');
    },
    (error: { code?: string; message?: string }) => ({
      code: error.code ?? 'none',
      message: error.message ?? '',
    }),
  );
}

describe('graceful stop — the ordered close over exact children', () => {
  it('stops ready children in order: worker internals close, then sockets, then both children terminate and reap', async () => {
    const lane = await startLane();
    await lane.supervisor.ready;
    expect(lane.supervisor.state).toBe('running');
    expect(lane.supervisor.admission).toBe('admitted');

    const report = await lane.supervisor.stop();
    expect(report).toMatchObject({
      reason: 'stopped',
      outcome: 'complete',
      failures: [],
    });
    expect(report.accounting).toMatchObject({
      workerReportReceived: true,
      workerCleanupComplete: true,
      workerReaped: true,
      managedAstroReaped: true,
      probesSettled: true,
      killEscalations: [],
    });
    expect(JSON.stringify(report)).not.toContain('pid');

    // The worker's internals closed (its stop + report + exit), and the
    // dev server received its TERM only after that — the AC's close order,
    // proven on monotonic cross-process stamps.
    const workerStop = await markerStamps(lane.markerDir, 'worker-stop-received');
    const workerExit = await markerStamps(lane.markerDir, 'worker-exit');
    const astroTerm = await markerStamps(lane.markerDir, 'astro-term-received');
    const astroExit = await markerStamps(lane.markerDir, 'astro-exit');
    expect(workerStop.length).toBe(1);
    expect(workerExit.length).toBe(1);
    expect(astroTerm.length).toBe(1);
    expect(astroExit.length).toBe(1);
    const first = (stamps: bigint[]): bigint => stamps[0] ?? BigInt(Number.MAX_SAFE_INTEGER);
    expect(first(workerStop)).toBeLessThan(first(astroTerm));
    expect(first(workerExit)).toBeLessThan(first(astroTerm));

    expect(lane.supervisor.state).toBe('closed');
    expect(lane.supervisor.admission).toBe('revoked');
    // Idempotent by contract: a second stop settles the SAME report.
    expect(await lane.supervisor.stop()).toBe(report);
    expect(await lane.supervisor.closed).toBe(report);
  }, 15_000);

  it("the worker's own incomplete cleanup makes the plane's report incomplete", async () => {
    const lane = await startLane({ workerBehaviors: { incompleteReport: true } });
    await lane.supervisor.ready;
    const report = await lane.supervisor.stop();
    expect(report.reason).toBe('stopped');
    expect(report.outcome).toBe('incomplete');
    expect(report.failures).toEqual(['worker-cleanup-incomplete']);
    expect(report.accounting.workerReportReceived).toBe(true);
    expect(report.accounting.workerCleanupComplete).toBe(false);
  }, 15_000);
});

describe('crash is terminal — the sibling is cleaned, never restarted', () => {
  it('a worker crash terminates the run, revokes admission, and cleans the managed-Astro sibling', async () => {
    const lane = await startLane();
    await lane.supervisor.ready;
    await crash(lane.workerControlDir);

    const report = await lane.supervisor.closed;
    expect(report).toMatchObject({
      reason: 'worker-crash',
      outcome: 'complete',
      failures: [],
    });
    expect(report.accounting.workerReaped).toBe(true);
    expect(report.accounting.managedAstroReaped).toBe(true);
    // The crash law's ledger (#365): the sibling died by SIGKILL in the
    // crash tick — no TERM rung ever ran, and the report says so instead
    // of pretending a graceful termination.
    expect(report.accounting.killEscalations).toEqual(['managed-astro']);
    expect(lane.supervisor.admission).toBe('revoked');
    expect(lane.supervisor.state).toBe('closed');

    // The sibling really died in the crash tick: it never received a
    // TERM (no marker) and a SIGKILLed process runs no exit handler —
    // the port witness proves the death cross-process.
    expect(await markerStamps(lane.markerDir, 'astro-term-received')).toHaveLength(0);
    expect(await markerStamps(lane.markerDir, 'astro-exit')).toHaveLength(0);
    expect(await portRefused(lane.port)).toBe(true);

    // No auto-restart: exactly one boot per child, ever.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await markerStamps(lane.markerDir, 'worker-boot')).toHaveLength(1);
    expect(await markerStamps(lane.markerDir, 'astro-boot')).toHaveLength(1);
  }, 15_000);

  it('a worker killed by SIGKILL reaps the TERM-immune dev sibling in the crash tick — the plane dies together (#365)', async () => {
    // The #365 poisoning construction, both halves: the worker dies by a
    // real OS signal (SIGKILL stays dead — no handler, no close report,
    // exactly a crashed bundled worker), and the dev sibling is
    // TERM-IMMUNE (the observed orphan's shape: an astro that survives a
    // TERM long enough to outlive its supervisor and hold Astro's
    // PID-checked dev lock). The crash law must still reap it — the
    // SIGKILL is delivered in the terminal transition's own synchronous
    // tick, before any awaited rung, so no degradation of the
    // supervisor's own machinery (the crash path's defining risk) can
    // leave the sibling alive.
    const lane = await startLane({ devServer: { ignoreTerm: true } });
    await lane.supervisor.ready;
    const workerPid = Number.parseInt(
      await readFile(join(lane.markerDir, 'worker-pid'), 'utf8'),
      10,
    );
    process.kill(workerPid, 'SIGKILL');

    const report = await lane.supervisor.closed;
    expect(report).toMatchObject({
      reason: 'worker-crash',
      outcome: 'complete',
      failures: [],
    });
    expect(report.accounting.workerReaped).toBe(true);
    expect(report.accounting.managedAstroReaped).toBe(true);
    expect(report.accounting.killEscalations).toEqual(['managed-astro']);
    expect(lane.supervisor.admission).toBe('revoked');
    expect(lane.supervisor.state).toBe('closed');

    // The TERM-immune sibling is dead by construction: no TERM ever
    // reached it, a SIGKILLed process runs no exit handler, and nothing
    // answers on its port — the death is proven cross-process,
    // independent of the report.
    expect(await markerStamps(lane.markerDir, 'astro-term-received')).toHaveLength(0);
    expect(await markerStamps(lane.markerDir, 'astro-exit')).toHaveLength(0);
    expect(await portRefused(lane.port)).toBe(true);

    // No auto-restart: exactly one boot per child, ever.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await markerStamps(lane.markerDir, 'worker-boot')).toHaveLength(1);
    expect(await markerStamps(lane.markerDir, 'astro-boot')).toHaveLength(1);
  }, 15_000);

  it('a pre-report worker boot failure reaps the TERM-immune sibling too — a failed activation leaves no live dev server (#365)', async () => {
    // The issue's exact failed-activation shape: the worker dies
    // pre-report (exit 74 at boot, no readiness answer), the activation
    // fails — and the TERM-immune dev sibling must not survive the
    // failed activation as the observed orphan did.
    const lane = await startLane({
      workerBehaviors: { bootFail: true },
      devServer: { ignoreTerm: true },
    });
    const rejection = await rejectedReady(lane.supervisor);
    expect(rejection.code).toBe('worker-crash');

    const report = await lane.supervisor.closed;
    expect(report.reason).toBe('worker-crash');
    expect(report.outcome).toBe('complete');
    expect(report.accounting.managedAstroReaped).toBe(true);
    expect(report.accounting.killEscalations).toEqual(['managed-astro']);
    expect(await portRefused(lane.port)).toBe(true);
  }, 15_000);

  it('a managed-Astro crash reaps the worker sibling in the crash tick — no stop, no TERM, only the kill (#402)', async () => {
    // The #402 mirror of #365's law: the dev server died, the worker
    // survives — and a crashed plane dies together. Before #402 the
    // surviving worker was owed a graceful window first (IPC stop → its
    // close report), so its decisive SIGKILL sat behind the AWAITED
    // stop-bound → TERM-grace → KILL ladder; a supervisor torn down
    // inside that window orphaned the worker (the mirror truncation
    // class — smaller blast radius than #365's, a leaked process rather
    // than a poisoned dev lock, and the same law anyway). The reap is
    // now delivered in the terminal transition's own synchronous tick:
    // the cooperative worker below would have stopped gracefully on
    // main (stop marker stamped, report received) — the tick kill
    // precedes every one of those rungs.
    const lane = await startLane();
    await lane.supervisor.ready;
    await crash(lane.astroControlDir);

    const report = await lane.supervisor.closed;
    expect(report).toMatchObject({
      reason: 'managed-astro-crash',
      outcome: 'complete',
      failures: [],
    });
    // The crash law denied the worker its window: no report was ever
    // expected (the supervisor killed it — it did not fail to report
    // inside a bound it was given), and the ledger says the worker died
    // by SIGKILL — the report never pretends a graceful stop.
    expect(report.accounting.workerReportReceived).toBe(false);
    expect(report.accounting.workerReaped).toBe(true);
    expect(report.accounting.managedAstroReaped).toBe(true);
    expect(report.accounting.killEscalations).toEqual(['worker']);
    expect(lane.supervisor.admission).toBe('revoked');
    expect(lane.supervisor.state).toBe('closed');

    // Nothing but the tick kill ever reached the worker: the IPC stop
    // never came (no marker — red on main, which stamped it), and a
    // SIGKILLed process runs no exit handler (the cooperative worker's
    // exit stamp is absent too — on main it exited 0 voluntarily).
    expect(await markerStamps(lane.markerDir, 'worker-stop-received')).toHaveLength(0);
    expect(await markerStamps(lane.markerDir, 'worker-exit')).toHaveLength(0);
    // The crashed dev server died its own death (its exit handler ran).
    expect(await markerStamps(lane.markerDir, 'astro-exit')).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await markerStamps(lane.markerDir, 'worker-boot')).toHaveLength(1);
    expect(await markerStamps(lane.markerDir, 'astro-boot')).toHaveLength(1);
  }, 15_000);

  it('a TERM-immune worker hanging on stop is reaped by the managed-astro crash tick, not the awaited ladder (#402)', async () => {
    // The issue's exact construction: the dev server crashes and the
    // surviving worker is the pathological one — it never answers the
    // stop and ignores SIGTERM (only a KILL can end it). On main the
    // decisive SIGKILL was reached only through the AWAITED ladder: the
    // full stop bound, then the full TERM grace, before the KILL — the
    // widened bounds below make that ladder need ≥ 3 s, while the
    // crash-tick reap resolves in single-digit milliseconds. The
    // deadline race is the truncation window made observable: a
    // supervisor torn down at the 2 s mark would have orphaned the
    // still-waiting worker on main; under the tick reap the plane is
    // long dead by then.
    const lane = await startLane({
      workerBehaviors: { hangStop: true },
      bounds: { stopTimeoutMs: 1500, termGraceMs: 1500 },
    });
    await lane.supervisor.ready;
    const workerPid = Number.parseInt(
      await readFile(join(lane.markerDir, 'worker-pid'), 'utf8'),
      10,
    );
    await crash(lane.astroControlDir);

    const deadline = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), 2000);
    });
    const report = await Promise.race([lane.supervisor.closed, deadline]);
    expect(report).not.toBeNull(); // red on main: the awaited ladder needs ≥ 3 s (1500 ms stop bound + 1500 ms TERM grace)
    expect(report).toMatchObject({
      reason: 'managed-astro-crash',
      outcome: 'complete',
      failures: [],
    });
    expect(report?.accounting.workerReportReceived).toBe(false);
    expect(report?.accounting.workerReaped).toBe(true);
    expect(report?.accounting.killEscalations).toEqual(['worker']);

    // Only the tick kill ever reached the TERM-immune worker: the stop
    // never came (on main it stamped worker-stop-received before
    // hanging), the TERM never came (on main the ladder's TERM rung
    // stamped worker-term-ignored), and a SIGKILLed process runs no
    // exit handler.
    expect(await markerStamps(lane.markerDir, 'worker-stop-received')).toHaveLength(0);
    expect(await markerStamps(lane.markerDir, 'worker-term-ignored')).toHaveLength(0);
    expect(await markerStamps(lane.markerDir, 'worker-exit')).toHaveLength(0);
    // The cross-process death witness: nothing answers the worker's PID
    // anymore — ESRCH, not a live process (the supervisor's report does
    // not carry PIDs; the witness is test machinery like #365's port).
    expect(() => process.kill(workerPid, 0)).toThrow();
  }, 15_000);

  it('a worker boot failure is terminal: ready rejects, the sibling is cleaned, no serving ever happened', async () => {
    const lane = await startLane({ workerBehaviors: { bootFail: true } });
    const rejection = await rejectedReady(lane.supervisor);
    expect(rejection.code).toBe('worker-crash');
    expect(rejection.message).toBe(
      'the project-runtime worker child terminated before the run completed',
    );

    const report = await lane.supervisor.closed;
    expect(report.reason).toBe('worker-crash');
    expect(report.outcome).toBe('complete');
    expect(report.accounting.managedAstroReaped).toBe(true);
    expect(existsSync(join(lane.markerDir, 'worker-boot.marker'))).toBe(false);
  }, 15_000);

  it('a dev server that cannot even spawn fails closed with a sanitized startup rejection', async () => {
    const broken = await makeScratch('astroix-sup-');
    const markerDir = join(broken, 'markers');
    await mkdir(markerDir);
    const port = await freePort();
    const supervisor = createProjectPlaneSupervisor({
      worker: {
        executable: process.execPath,
        argv: [STAND_IN_WORKER, JSON.stringify({ markerDir })],
        cwd: broken,
        env: minimalChildEnv(process.env),
        ipc: true,
        execArgv: [],
      },
      managedAstro: {
        executable: join(broken, 'no-such-node-executable'),
        argv: ['dev'],
        cwd: broken,
        env: minimalChildEnv(process.env),
        ipc: false,
      },
      devServerPort: port,
      startupTimeoutMs: 3000,
      // The #402 crash law makes the close a tick reap: the spawn error
      // fires at t≈0 while the worker is mid-boot, and the SIGKILLed
      // worker is owed no window — the old widened stop bound existed
      // to let its loaded boot reach the graceful stop before the bound
      // TERMed it mid-boot and voided the close report; with no report
      // ever expected on a crash path, no boot-race accommodation
      // remains, and the bound only guards the probes' abort settling.
      stopTimeoutMs: 10_000,
      termGraceMs: 200,
      killReapMs: 200,
      probeIntervalMs: 15,
    });
    const lane: Lane = {
      supervisor,
      markerDir,
      workerControlDir: broken,
      astroControlDir: broken,
      scratch: broken,
      port,
    };
    lanes.push(lane);

    const rejection = await rejectedReady(supervisor);
    expect(rejection.code).toBe('managed-astro-crash');
    expect(rejection.message).toBe(
      'the managed Astro dev server terminated before the run completed',
    );
    expect(rejection.message).not.toContain(broken);
    const report = await supervisor.closed;
    expect(report.reason).toBe('managed-astro-crash');
    expect(report.outcome).toBe('complete');
    // The crash-killed worker (possibly still mid-boot) was never asked
    // for a report — the mirror tick reap (#402), recorded in the ledger.
    expect(report.accounting.workerReportReceived).toBe(false);
    expect(report.accounting.workerReaped).toBe(true);
    expect(report.accounting.killEscalations).toEqual(['worker']);
  }, 15_000);
});

describe('startup cancellation and the startup deadline', () => {
  it('a stop during startup cancels: both children terminated, probes aborted, complete report', async () => {
    // stopTimeoutMs widened for #322's boot-race family: the stop control
    // is IPC-buffered until the worker is up, but the graceful close that
    // awaits it is bounded — a bound tighter than a loaded boot would TERM
    // the worker mid-boot (default disposition, no exit handler) and void
    // its voluntary-exit marker below.
    const lane = await startLane({
      devServer: { mode: 'hang' },
      bounds: { stopTimeoutMs: 10_000 },
    });
    const rejection = rejectedReady(lane.supervisor);
    const report = await lane.supervisor.stop();
    expect(report).toMatchObject({ reason: 'cancelled', outcome: 'complete', failures: [] });
    expect(report.accounting.probesSettled).toBe(true);
    // Both exact children terminated and reaped — a child cancelled
    // mid-boot may die by default SIGTERM before it ever registers an
    // exit handler, so reaping is asserted from the report, not markers.
    expect(report.accounting.workerReaped).toBe(true);
    expect(report.accounting.managedAstroReaped).toBe(true);
    expect((await rejection).code).toBe('cancelled');
    expect(await markerStamps(lane.markerDir, 'worker-exit')).toHaveLength(1);
  }, 15_000);

  it('a never-ready dev server hits the startup deadline: terminal close, children terminated', async () => {
    // The deadline's SIGTERM races the dev server's node boot: under
    // suite-scale load the child can still be mid-boot when the terminal
    // close reaches it, and a SIGTERM delivered before the child has
    // registered its handlers is a default-disposition kill — no exit
    // handler runs, so no astro-exit stamp EVER lands while the reap is
    // honestly complete (#322: 20/90 probe runs under a concurrent suite
    // died pre-boot, boot stamp absent too). The awaitAstroListening
    // rendezvous closes the race by construction: the worker holds its
    // close report until the sibling stamped astro-listening (written
    // strictly after its SIGTERM/exit handlers are registered), and the
    // supervisor TERMs the dev server only after that report — the exit
    // stamp becomes a causal consequence of the signal. The widened stop
    // bound gives both children's loaded boots room inside the rendezvous.
    const lane = await startLane({
      workerBehaviors: { awaitAstroListening: true },
      devServer: { mode: 'hang' },
      bounds: { startupTimeoutMs: 350, stopTimeoutMs: 10_000 },
    });
    const rejection = await rejectedReady(lane.supervisor);
    expect(rejection.code).toBe('startup-timeout');
    expect(rejection.message).toBe(
      'the project plane did not become ready within the startup deadline',
    );

    const report = await lane.supervisor.closed;
    expect(report.reason).toBe('startup-timeout');
    expect(report.outcome).toBe('complete');
    expect(report.accounting.managedAstroReaped).toBe(true);
    expect(await markerStamps(lane.markerDir, 'astro-exit')).toHaveLength(1);
  }, 15_000);

  it('a worker whose project inspection FAILS is never admitted — the startup deadline terminates the plane', async () => {
    const lane = await startLane({
      workerBehaviors: { probeFail: true },
      // stopTimeoutMs widened for #322's boot-race family: the deadline
      // still fires at 350 ms, but the worker's stop-received stamp stays
      // causal (IPC-buffered, then honored) however slow its loaded boot.
      bounds: { startupTimeoutMs: 350, stopTimeoutMs: 10_000 },
    });
    const rejection = await rejectedReady(lane.supervisor);
    expect(rejection.code).toBe('startup-timeout');

    const report = await lane.supervisor.closed;
    expect(report.reason).toBe('startup-timeout');
    expect(report.outcome).toBe('complete');
    // Not admitted — and never was: the failed probe answer is not readiness.
    expect(lane.supervisor.admission).toBe('revoked');
    expect(lane.supervisor.state).toBe('closed');
    // The worker stayed alive until the terminal stop (it only ever failed
    // the inspection), answered the stop, and was reaped.
    expect(await markerStamps(lane.markerDir, 'worker-boot')).toHaveLength(1);
    expect(await markerStamps(lane.markerDir, 'worker-stop-received')).toHaveLength(1);
    expect(report.accounting.workerReaped).toBe(true);
    expect(report.accounting.managedAstroReaped).toBe(true);
  }, 15_000);
});

describe('escalation and the reap bounds', () => {
  it('an ignored SIGTERM escalates to SIGKILL — reaped, escalated, still complete', async () => {
    const lane = await startLane({ devServer: { ignoreTerm: true } });
    await lane.supervisor.ready;
    const report = await lane.supervisor.stop();

    expect(report.outcome).toBe('complete');
    expect(report.failures).toEqual([]);
    expect(report.accounting.killEscalations).toEqual(['managed-astro']);
    expect(report.accounting.managedAstroReaped).toBe(true);
    // The TERM really was delivered and ignored; only the KILL ended it
    // (a SIGKILLed process runs no exit handler).
    expect(await markerStamps(lane.markerDir, 'astro-term-received')).toHaveLength(1);
    expect(await markerStamps(lane.markerDir, 'astro-exit')).toHaveLength(0);
  }, 15_000);

  it('a worker that hangs on stop and ignores TERM fails its report category, then dies by KILL', async () => {
    const lane = await startLane({ workerBehaviors: { hangStop: true } });
    await lane.supervisor.ready;
    const report = await lane.supervisor.stop();

    expect(report.reason).toBe('stopped');
    expect(report.outcome).toBe('incomplete');
    expect(report.failures).toEqual(['worker-close-report']);
    expect(report.accounting.workerReportReceived).toBe(false);
    expect(report.accounting.workerReaped).toBe(true);
    expect(report.accounting.killEscalations).toEqual(['worker']);
    // The stop really reached the worker (its marker proves receipt) and
    // the TERM really was ignored — only the KILL ladder ended it.
    expect(await markerStamps(lane.markerDir, 'worker-stop-received')).toHaveLength(1);
    expect(await markerStamps(lane.markerDir, 'worker-term-ignored')).toHaveLength(1);
    expect(await markerStamps(lane.markerDir, 'worker-exit')).toHaveLength(0);
  }, 15_000);

  it('a TERM-delaying dev server dies by the SIGKILL ladder — observed reap, honest complete report, no PID', async () => {
    // #322: this leg was the "unobserved exit after SIGKILL" zero-bound
    // gamble (killReapMs: 0 → 'incomplete'), but a zero reap bound was a
    // scheduling coin, not a construction: the SIGKILLed child dies in
    // microseconds and nothing test-side can delay its death or the
    // supervisor's exit-event observation, so the clamped 1 ms bound timer
    // raced the SIGCHLD-driven exit event on parent preemption — calm
    // loops stamped 'incomplete', concurrent-suite load stamped 'complete'
    // (4/90 probe runs; the CI signature). #326's pin gave the zero bound
    // already-observed-only semantics (the post-SIGKILL reap reads the
    // child's exit observation synchronously), so the unobserved half is
    // BACK as the zero-bound sibling leg below — deterministic now. This
    // leg keeps the scenario's other half: the escalation ladder itself,
    // its observed reap inside the lane's default (positive) bound, and
    // the KILL-only death. (That half overlaps the ignoreTerm leg's
    // assertions: at a positive bound an ignoring child and a delaying
    // one are one observable surface here.)
    const lane = await startLane({ devServer: { termDelayMs: 5000 } });
    await lane.supervisor.ready;
    const report = await lane.supervisor.stop();

    expect(report.outcome).toBe('complete');
    expect(report.failures).toEqual([]);
    expect(report.accounting.killEscalations).toEqual(['managed-astro']);
    expect(report.accounting.managedAstroReaped).toBe(true);
    expect(report.accounting.workerReaped).toBe(true);
    // The TERM really reached the delaying child, and only the KILL ended
    // it — a SIGKILLed process runs no exit handler, and its own delayed
    // exit was still ~4.8 s away when the ladder escalated.
    expect(await markerStamps(lane.markerDir, 'astro-term-received')).toHaveLength(1);
    expect(await markerStamps(lane.markerDir, 'astro-exit')).toHaveLength(0);
    expect(JSON.stringify(report)).not.toContain('pid');
  }, 15_000);

  it('an unobserved exit after SIGKILL reports the honest incomplete reap — no PID, no false complete', async () => {
    // The zero-bound leg, restored verbatim (#326): killReapMs ≤ 0 means
    // already-observed-only — the supervisor decides `reaped` from the
    // child's synchronous exit observation instead of the timer race, so
    // the unobserved-exit scenario is CONSTRUCTIBLE against real children
    // again (before the pin it was not: SIGKILL kills in microseconds, and
    // the clamped 1 ms timer racing the exit event answered by OS
    // scheduling). Deterministic by the pin's invariant: the TERM grace
    // just expired unresolved, and the exit event that would set
    // exitCode/signalCode is the very event the supervisor still awaits —
    // it cannot have been processed at the check, so a child alive at
    // escalation (the delaying child, its own exit ~4.8 s away) reads
    // reaped: false on any machine load. The real-IO wiring witness for
    // the classification already covered in close-report.test.ts
    // (managedAstroReaped: false ⇒ 'managed-astro-reap').
    const lane = await startLane({
      devServer: { termDelayMs: 5000 },
      bounds: { killReapMs: 0 },
    });
    await lane.supervisor.ready;
    const report = await lane.supervisor.stop();

    expect(report.outcome).toBe('incomplete');
    expect(report.failures).toContain('managed-astro-reap');
    expect(report.accounting.managedAstroReaped).toBe(false);
    expect(report.accounting.workerReaped).toBe(true);
    expect(JSON.stringify(report)).not.toContain('pid');
  }, 15_000);
});

describe('the worker-wire facet — consumer traffic over the supervised wire (#308)', () => {
  it('dispatches correlated typed inspections (ids ≥ 1) to the supervised worker while the probe keeps id 0', async () => {
    const lane = await startLane();
    const rawFrames: unknown[] = [];
    lane.supervisor.workerWire.on('message', (frame) => rawFrames.push(frame));
    // The raw listener was bound before readiness: the probe's id-0
    // answer crossed the supervisor in that window and must NOT cross
    // the facet — consumer traffic runs alongside it without collision.
    await lane.supervisor.ready;

    const first = await lane.supervisor.workerWire.dispatch({ kind: 'project' });
    const second = await lane.supervisor.workerWire.dispatch({ kind: 'routes' });
    // The stand-in echoes the wire id as the revision and the request's
    // kind — the correlated answer is provable end-to-end.
    expect(first).toMatchObject({ kind: 'project', revision: 1 });
    expect(second).toMatchObject({ kind: 'routes', revision: 2 });
    expect(rawFrames.map((frame) => (frame as { id?: number }).id)).toEqual([1, 2]);
    await lane.supervisor.stop();
  }, 15_000);

  it('binds a raw D5-idiom client: an explicit consumer id through send(), correlated by hand', async () => {
    const lane = await startLane();
    await lane.supervisor.ready;
    const wire = lane.supervisor.workerWire;
    const answer = new Promise<unknown>((resolve) => {
      const listener = (message: unknown): void => {
        const frame = message as { type?: string; id?: number };
        if (frame?.type === 'inspect-result' && frame.id === 41) {
          wire.removeListener('message', listener);
          resolve(message);
        }
      };
      wire.on('message', listener);
    });
    expect(wire.send({ type: 'inspect', id: 41, request: { kind: 'content' } })).toBe(true);
    const frame = (await answer) as {
      ok?: boolean;
      result?: { kind?: string; revision?: number };
    };
    expect(frame.ok).toBe(true);
    expect(frame.result).toMatchObject({ kind: 'content', revision: 41 });
    await lane.supervisor.stop();
  }, 15_000);

  it("forwards the worker's public event frames to facet subscribers, and the unbind holds", async () => {
    const lane = await startLane();
    await lane.supervisor.ready;
    const events: unknown[] = [];
    const unsubscribe = lane.supervisor.workerWire.subscribe((event) => events.push(event));
    await writeFile(join(lane.workerControlDir, 'emit-event'), '', { mode: 0o600 });
    await vi.waitFor(() => {
      if (events.length === 0) throw new Error('event frame not yet received');
    });
    expect(events).toEqual([{ type: 'invalidation', families: ['styles'], revision: 2 }]);

    unsubscribe();
    await writeFile(join(lane.workerControlDir, 'emit-event'), 'again', { mode: 0o600 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events).toHaveLength(1); // the unbound subscriber sees nothing further
    await lane.supervisor.stop();
  }, 15_000);

  it("refuses the supervisor's reserved traffic at send() and withholds its frames from consumers", async () => {
    const lane = await startLane();
    const rawFrames: unknown[] = [];
    lane.supervisor.workerWire.on('message', (frame) => rawFrames.push(frame));
    await lane.supervisor.ready;
    const wire = lane.supervisor.workerWire;
    expect(wire.send({ type: 'stop' })).toBe(false); // the stop control is the supervisor's
    expect(wire.send({ type: 'inspect', id: 0, request: { kind: 'project' } })).toBe(false); // id 0 is the probe's
    expect(wire.send({ type: 'restart' })).toBe(false); // off-union: would be a protocol violation in the child

    // None of it reached the worker: it still serves consumer dispatches.
    expect(await wire.dispatch({ kind: 'project' })).toMatchObject({ revision: 1 });
    await lane.supervisor.stop();

    // The supervisor's frames — the probe answer, the close report — never crossed.
    expect(rawFrames.length).toBeGreaterThan(0);
    for (const frame of rawFrames) {
      const wireFrame = frame as { type?: string; id?: number };
      expect(wireFrame.type).not.toBe('closed');
      expect(wireFrame.id).not.toBe(0);
    }
  }, 15_000);

  it('settles a failed consumer inspection as the structured worker rejection — an answer, not a crash', async () => {
    const lane = await startLane({ workerBehaviors: { failInspectIds: [1] } });
    await lane.supervisor.ready;
    expect(await facetRejection(lane.supervisor.workerWire.dispatch({ kind: 'project' }))).toBe(
      'inspection-failed',
    );
    expect(lane.supervisor.state).toBe('running');
    expect(await lane.supervisor.workerWire.dispatch({ kind: 'project' })).toMatchObject({
      revision: 2,
    });
    await lane.supervisor.stop();
  }, 15_000);

  it('rejects post-stop dispatches structured shutdown and dies with the plane: send false, connected false', async () => {
    const lane = await startLane();
    await lane.supervisor.ready;
    const stopping = lane.supervisor.stop(); // the terminal transition is synchronous
    expect(await facetRejection(lane.supervisor.workerWire.dispatch({ kind: 'project' }))).toBe(
      'shutdown',
    );
    await stopping;

    const wire = lane.supervisor.workerWire;
    expect(wire.connected).toBe(false);
    expect(wire.send({ type: 'inspect', id: 5, request: { kind: 'project' } })).toBe(false);
    expect(await facetRejection(wire.dispatch({ kind: 'project' }))).toBe('shutdown');
  }, 15_000);

  it('a worker crash mid-dispatch settles the in-flight dispatch structured; the facet dies with the child', async () => {
    const lane = await startLane({ workerBehaviors: { hangInspectIds: [1] } });
    await lane.supervisor.ready;
    const dispatch = lane.supervisor.workerWire.dispatch({ kind: 'project' });
    await waitForMarker(lane.markerDir, 'worker-inspect-hang'); // the child holds the request unanswered
    await crash(lane.workerControlDir);

    expect(await facetRejection(dispatch)).toBe('shutdown');
    expect(lane.supervisor.workerWire.connected).toBe(false);
    const report = await lane.supervisor.closed;
    expect(report.reason).toBe('worker-crash');
    expect(report.outcome).toBe('complete');
  }, 15_000);

  it('carries no PID, port, or child handle on its surface or its frames', async () => {
    const lane = await startLane();
    const rawFrames: unknown[] = [];
    lane.supervisor.workerWire.on('message', (frame) => rawFrames.push(frame));
    await lane.supervisor.ready;
    await lane.supervisor.workerWire.dispatch({ kind: 'project' });

    const wire = lane.supervisor.workerWire;
    expect(Object.keys(wire).sort()).toEqual([
      'connected',
      'dispatch',
      'on',
      'removeListener',
      'send',
      'subscribe',
    ]);
    const serialized = `${JSON.stringify(wire)}${JSON.stringify(rawFrames)}`;
    expect(serialized).not.toContain('pid');
    expect(serialized).not.toContain(STAND_IN_WORKER); // no raw child path
    await lane.supervisor.stop();
  }, 15_000);
});

describe('the exact-child spawn discipline over real children', () => {
  it('spawns exact executables with explicit argv into a metacharacter canonical cwd under a poisoned environment', async () => {
    const scratch = await makeScratch('astroix-sup-');
    const hostileBin = join(scratch, 'hostile-bin');
    await mkdir(hostileBin);
    const hostile = (): string =>
      `#!/bin/sh\necho pwned > ${JSON.stringify(join(scratch, 'hostile-ran.marker'))}\nexit 66\n`;
    await writeFile(join(hostileBin, 'node'), hostile(), { mode: 0o755 });
    await writeFile(join(hostileBin, 'astro'), hostile(), { mode: 0o755 });

    const poisoned: Record<string, string | undefined> = {
      PATH: `${hostileBin}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      NODE_OPTIONS: '--require /nonexistent/pwned.cjs',
      ASTROIX_SECRET: 'sekrit-value',
      GITHUB_TOKEN: 'ghp-hostile',
    };
    // A shell would eat this root alive: metacharacters, spaces, the works.
    const metacharRoot = join(scratch, 'prj-;touch pwned $(pwned) `id`');
    await mkdir(metacharRoot);

    const env = minimalChildEnv(poisoned);
    const workerSnapshot = join(scratch, 'worker-snapshot.json');
    const astroSnapshot = join(scratch, 'astro-snapshot.json');
    const lane = await startLane({
      env,
      cwd: metacharRoot,
      workerSnapshotPath: workerSnapshot,
      astroSnapshotPath: astroSnapshot,
      bounds: { startupTimeoutMs: 8000 },
    });
    await lane.supervisor.ready;
    const report = await lane.supervisor.stop();
    expect(report.outcome).toBe('complete');

    const canonical = await realpath(metacharRoot);
    const worker = JSON.parse(await readFile(workerSnapshot, 'utf8')) as {
      argv: string[];
      cwd: string;
      env: Record<string, string>;
    };
    const astro = JSON.parse(await readFile(astroSnapshot, 'utf8')) as {
      argv: string[];
      cwd: string;
      env: Record<string, string>;
    };

    // Canonical cwd, exact executable, argv passed as single tokens.
    // (macOS injects __CF_USER_TEXT_ENCODING into every spawned child's
    // environment at the syscall boundary — the one platform addition,
    // never ours; everything else must be the whitelist exactly.)
    const platformInjected = new Set(['__CF_USER_TEXT_ENCODING']);
    const childEnvKeys = (child: { env: Record<string, string> }): string[] =>
      Object.keys(child.env)
        .filter((key) => !platformInjected.has(key))
        .sort();
    for (const child of [worker, astro]) {
      expect(child.cwd).toBe(canonical);
      expect(child.argv[0]).toBe(process.execPath);
      expect(childEnvKeys(child)).toEqual(Object.keys(env).sort());
      for (const [key, value] of Object.entries(env)) {
        expect(child.env[key]).toBe(value);
      }
      expect(Object.hasOwn(child.env, 'NODE_OPTIONS')).toBe(false);
    }
    expect(worker.argv[1]).toBe(STAND_IN_WORKER);
    expect(astro.argv[1]).toBe(STAND_IN_DEV_SERVER);
    const astroArgument = JSON.parse(astro.argv[2] ?? '{}') as { port?: number };
    expect(typeof astroArgument.port).toBe('number');

    // Secret-free: the serialized child environments carry none of the poisons.
    for (const serialized of [JSON.stringify(worker.env), JSON.stringify(astro.env)]) {
      expect(serialized).not.toContain('sekrit');
      expect(serialized).not.toContain('ghp-');
    }

    // No shell ever parsed anything: the metacharacter root produced no
    // side-effect files, and the PATH-hostile executables never ran.
    expect(existsSync(join(scratch, 'hostile-ran.marker'))).toBe(false);
    expect(existsSync(join(scratch, 'pwned'))).toBe(false);
    expect(existsSync(join(metacharRoot, 'pwned'))).toBe(false);
    expect(existsSync(join(canonical, 'pwned'))).toBe(false);
  }, 20_000);
});

describe('the production worker spawn plan', () => {
  it("forks E6's worker-child out of the canonical root, with the bundled-Node override mirroring the dev-server plan", async () => {
    const scratch = await makeScratch('astroix-sup-');
    const canonical = await realpath(scratch);

    const plan = await workerSpawnPlan({ projectRoot: scratch });
    expect(plan.executable).toBe(process.execPath);
    expect(plan.ipc).toBe(true);
    expect(plan.cwd).toBe(canonical);
    expect(plan.argv[0]).toMatch(/worker-child\.ts$/); // the dev-checkout spelling; the packaged runtime rebases (ADR-0008)
    expect(JSON.parse(plan.argv[1] ?? '{}')).toEqual({ projectRoot: canonical });
    expect(plan.env.ASTRO_TELEMETRY_DISABLED).toBe('1');
    expect(Object.hasOwn(plan.env, 'NODE_OPTIONS')).toBe(false);

    // The sibling symmetry the reviewer pinned: one executable override
    // shape for both children — the packaged runtime's bundled stock Node.
    const overridden = await workerSpawnPlan({
      projectRoot: scratch,
      nodeExecutable: '/opt/astroix-node/bin/node',
    });
    expect(overridden.executable).toBe('/opt/astroix-node/bin/node');
    expect(overridden.cwd).toBe(canonical);
  });
});
