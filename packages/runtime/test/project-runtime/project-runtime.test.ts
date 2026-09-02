import { findDisclosure } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import type { SupervisionCloseReport } from '../../project-plane/supervision/close-report.ts';
import type { WorkerEvent } from '../../project-plane/worker/worker-events.ts';
import {
  malformedRequestFailure,
  shutdownFailure,
  WorkerRejectionError,
} from '../../project-plane/worker/worker-failure.ts';
import type { WorkerInspectionResult } from '../../project-plane/worker/worker-request.ts';
import {
  createProjectRuntime,
  type LaunchPlane,
  type ProjectRun,
  ProjectRunBootError,
  type ProjectRunBootErrorCode,
} from '../../project-runtime/project-runtime.ts';
import type { ProxyHealthPrerequisite } from '../../project-runtime/proxy-health.ts';
import { completeReport, type FakePlane, fakePlane } from './plane-fakes.ts';

/**
 * The #232 focused tests: the ProjectRuntime/ProjectRun facade contract
 * over fakes at exactly the consumed seams — the plane supervisor
 * (ready/stop/closed/workerWire) and the proxy-health prerequisite.
 * Immediate-handle/readiness sequencing, stop-during-start convergence,
 * typed-only four-family dispatch, event forwarding, idempotent stop to
 * THE one close report, crash/startup-failure convergence, and the
 * public-shape redaction sweep over every result, event, report, and
 * error the surface can produce.
 */

/** The hostile start identity every redaction sweep runs against — a path and a port that must never surface. */
const HOSTILE_ROOT = '/Users/secret/root-232';
const HOSTILE_PORT = 4242;

interface HealthFake {
  readonly health: ProxyHealthPrerequisite;
  readonly calls: Array<{ readonly signal?: AbortSignal }>;
  /** Resolves the pending check. */
  settle(): void;
  /** Rejects the pending check with an error whose text would leak if surfaced. */
  fail(): void;
}

function fakeHealth(): HealthFake {
  const calls: Array<{ signal?: AbortSignal }> = [];
  let settle: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const pending = new Promise<void>((resolve, fail) => {
    settle = resolve;
    reject = fail;
  });
  pending.catch(() => {}); // anchored: the facade surfaces it, the fake never hangs a test
  return {
    health: {
      check: (input) => {
        calls.push({ signal: input.signal });
        return pending;
      },
    },
    calls,
    settle: () => settle(),
    fail: () => reject(new Error('proxy unhealthy at /Users/secret/root port 9100 (pid 77)')),
  };
}

interface LaunchControl {
  readonly launchPlane: LaunchPlane;
  readonly inputs: Array<{ readonly projectRoot: string; readonly devServerPort: number }>;
  /** Resolves the launch with a fresh fake plane. */
  arrive(): FakePlane;
  /** Rejects the launch with an error whose text would leak if surfaced. */
  fail(): void;
}

function controllableLaunch(): LaunchControl {
  const inputs: LaunchControl['inputs'] = [];
  let resolve: (plane: FakePlane['supervisor']) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const launched = new Promise<FakePlane['supervisor']>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  launched.catch(() => {}); // anchored
  return {
    launchPlane: (input) => {
      inputs.push(input);
      return launched;
    },
    inputs,
    arrive: () => {
      const plane = fakePlane();
      resolve(plane.supervisor);
      return plane;
    },
    fail: () => reject(new Error(`cannot resolve astro at ${HOSTILE_ROOT} (pid 4242, port 9999)`)),
  };
}

/** A runtime over one arrived, ready plane — the common fixture (satisfied health by default). */
async function readyRun(): Promise<{ run: ProjectRun; plane: FakePlane }> {
  const control = controllableLaunch();
  const runtime = createProjectRuntime({ launchPlane: control.launchPlane });
  const run = runtime.start({ projectRoot: HOSTILE_ROOT, devServerPort: HOSTILE_PORT });
  const plane = control.arrive();
  plane.settleReady();
  await run.ready;
  return { run, plane };
}

/** 'pending' when the promise has not settled within the window — observation, never a timing assertion. */
async function settlementOf(promise: Promise<unknown>, windowMs = 20): Promise<string> {
  return await Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise<string>((resolve) => {
      setTimeout(() => resolve('pending'), windowMs);
    }),
  ]);
}

/** One macrotask boundary — every chained microtask of a resolved deferred has run. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function bootErrorOf(promise: Promise<unknown>): Promise<ProjectRunBootError> {
  const error = await rejectionOf(promise);
  if (!(error instanceof ProjectRunBootError)) {
    throw new Error(`expected a ProjectRunBootError, observed: ${String(error)}`);
  }
  return error;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

describe('start hands back the handle immediately', () => {
  it('returns the five-member run synchronously, before anything settles, and passes the identity through', async () => {
    const control = controllableLaunch();
    const runtime = createProjectRuntime({ launchPlane: control.launchPlane });

    const run = runtime.start({ projectRoot: HOSTILE_ROOT, devServerPort: HOSTILE_PORT });

    expect(Object.keys(run).sort()).toEqual(['closed', 'inspect', 'ready', 'stop', 'subscribe']);
    expect(typeof run.inspect).toBe('function');
    expect(typeof run.stop).toBe('function');
    expect(typeof run.subscribe).toBe('function');
    expect(run.ready).toBeInstanceOf(Promise);
    expect(run.closed).toBeInstanceOf(Promise);
    // The launch was asked for exactly this identity (canonicalization is
    // the launcher's) — one microtask later, never a second start's work.
    await flush();
    expect(control.inputs).toEqual([{ projectRoot: HOSTILE_ROOT, devServerPort: HOSTILE_PORT }]);
  });

  it('the handle is usable mid-start: a dispatch made before the plane exists settles after it arrives', async () => {
    const control = controllableLaunch();
    const runtime = createProjectRuntime({ launchPlane: control.launchPlane });
    const run = runtime.start({ projectRoot: HOSTILE_ROOT, devServerPort: HOSTILE_PORT });

    const asked = run.inspect({ kind: 'project' });
    expect(await settlementOf(asked)).toBe('pending');
    const plane = control.arrive();
    plane.settleReady();

    const result = await asked;
    expect(result.kind).toBe('project');
    expect(plane.wire.requests).toEqual([{ kind: 'project' }]);
  });
});

describe('readiness sequencing — the plane prerequisites first, proxy-health last', () => {
  it('ready stays pending while the plane is starting; the health leg holds it open until it passes', async () => {
    const health = fakeHealth();
    const control = controllableLaunch();
    const runtime = createProjectRuntime({
      launchPlane: control.launchPlane,
      proxyHealth: health.health,
    });
    const run = runtime.start({ projectRoot: HOSTILE_ROOT, devServerPort: HOSTILE_PORT });

    expect(await settlementOf(run.ready)).toBe('pending');
    expect(health.calls).toHaveLength(0);

    const plane = control.arrive();
    plane.settleReady();
    await flush();
    // The plane is ready; the health leg — called once, with the startup
    // abort signal — now holds readiness open.
    expect(health.calls).toHaveLength(1);
    expect(health.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(await settlementOf(run.ready)).toBe('pending');

    health.settle();
    await run.ready;
  });

  it('the default runtime uses the declared-but-satisfied health seam — ready resolves right after the plane', async () => {
    const control = controllableLaunch();
    const runtime = createProjectRuntime({ launchPlane: control.launchPlane }); // no health injected
    const run = runtime.start({ projectRoot: HOSTILE_ROOT, devServerPort: HOSTILE_PORT });
    const plane = control.arrive();

    plane.settleReady();
    await run.ready; // the deferred F1 check passes by construction
  });
});

describe('terminal startup outcomes — one sanitized boot error and one report', () => {
  it('a failed health check fails the startup: sanitized boot error, plane stopped, one report', async () => {
    const health = fakeHealth();
    const control = controllableLaunch();
    const runtime = createProjectRuntime({
      launchPlane: control.launchPlane,
      proxyHealth: health.health,
    });
    const run = runtime.start({ projectRoot: HOSTILE_ROOT, devServerPort: HOSTILE_PORT });
    const plane = control.arrive();
    plane.settleReady();
    await flush();

    health.fail();
    const error = await bootErrorOf(run.ready);
    expect(error.code).toBe('proxy-health');
    expect(error.message).toBe('the proxy health prerequisite failed during project startup');
    // The underlying leaky check text never surfaced.
    expect(error.message).not.toContain(HOSTILE_ROOT);
    expect(findDisclosure(error.message)).toBeNull();
    // Terminal convergence: the plane was stopped, and the one report settles everywhere.
    expect(plane.stopCalls).toBe(1);
    plane.closeWith(completeReport('stopped'));
    const report = await run.closed;
    expect(report.reason).toBe('stopped');
    expect(await run.stop()).toBe(report);
  });

  it('a stop during the health check cancels: the check observes the abort, ready rejects cancelled, one report', async () => {
    const health = fakeHealth();
    const control = controllableLaunch();
    const runtime = createProjectRuntime({
      launchPlane: control.launchPlane,
      proxyHealth: health.health,
    });
    const run = runtime.start({ projectRoot: HOSTILE_ROOT, devServerPort: HOSTILE_PORT });
    const plane = control.arrive();
    plane.settleReady();
    await flush();
    expect(health.calls).toHaveLength(1);

    const stopping = run.stop();
    const error = await bootErrorOf(run.ready);
    expect(error.code).toBe('cancelled');
    expect(health.calls[0]?.signal?.aborted).toBe(true);

    plane.closeWith(completeReport('stopped'));
    const report = await stopping;
    expect(await run.closed).toBe(report);
    expect(await run.stop()).toBe(report);
  });

  it('a stop before the plane becomes ready rejects ready as cancelled and settles the plane report', async () => {
    const control = controllableLaunch();
    const runtime = createProjectRuntime({ launchPlane: control.launchPlane });
    const run = runtime.start({ projectRoot: HOSTILE_ROOT, devServerPort: HOSTILE_PORT });
    const plane = control.arrive();

    const stopping = run.stop();
    const error = await bootErrorOf(run.ready);
    expect(error.code).toBe('cancelled');
    expect(error.message).toBe('the project plane was stopped before it became ready');

    plane.closeWith(completeReport('cancelled'));
    const report = await stopping;
    expect(report.reason).toBe('cancelled');
    expect(await run.stop()).toBe(report);
    expect(await run.closed).toBe(report);
  });

  it('a stop before the launch settles still stops the plane the moment it arrives', async () => {
    const control = controllableLaunch();
    const runtime = createProjectRuntime({ launchPlane: control.launchPlane });
    const run = runtime.start({ projectRoot: HOSTILE_ROOT, devServerPort: HOSTILE_PORT });

    const stopping = run.stop();
    const plane = control.arrive();
    await flush();
    expect(plane.stopCalls).toBe(1);

    plane.closeWith(completeReport('cancelled'));
    const report = await stopping;
    expect(report.reason).toBe('cancelled');
    expect(await run.closed).toBe(report);
  });

  it('a rejected launch fails ready sanitized and converges to the never-spawned report', async () => {
    const health = fakeHealth();
    const control = controllableLaunch();
    const runtime = createProjectRuntime({
      launchPlane: control.launchPlane,
      proxyHealth: health.health,
    });
    const run = runtime.start({ projectRoot: HOSTILE_ROOT, devServerPort: HOSTILE_PORT });

    control.fail();
    const error = await bootErrorOf(run.ready);
    expect(error.code).toBe('launch-failed');
    expect(error.message).toBe('the project plane could not be launched for the requested project');
    expect(error.message).not.toContain(HOSTILE_ROOT);
    // No plane ever existed: nothing for the health leg to gate on.
    expect(health.calls).toHaveLength(0);

    const report = await run.closed;
    expect(report).toMatchObject({ reason: 'cancelled', outcome: 'complete', failures: [] });
    expect(report.accounting.workerReportReceived).toBe(false);
    // stop after the failure settles the SAME instance the report already did.
    expect(await run.stop()).toBe(report);
    // New work rejects structured — never a raw launch error.
    const rejection = await rejectionOf(run.inspect({ kind: 'project' }));
    expect(rejection).toBeInstanceOf(WorkerRejectionError);
    if (rejection instanceof WorkerRejectionError) {
      expect(rejection.failure.code).toBe('shutdown');
    }
  });

  it("a supervisor boot failure maps through: the sanitized code carries, the message is the facade's template", async () => {
    const control = controllableLaunch();
    const runtime = createProjectRuntime({ launchPlane: control.launchPlane });
    const run = runtime.start({ projectRoot: HOSTILE_ROOT, devServerPort: HOSTILE_PORT });
    const plane = control.arrive();

    plane.failReady('startup-timeout');
    const error = await bootErrorOf(run.ready);
    expect(error).toBeInstanceOf(ProjectRunBootError);
    expect(error.code).toBe('startup-timeout');
    expect(error.message).toBe(
      'the project plane did not become ready within the startup deadline',
    );
  });
});

describe('typed inspection across the four families', () => {
  it('dispatches each exact typed request and settles the revisioned typed result', async () => {
    const { run, plane } = await readyRun();
    const requests = [
      { kind: 'project' },
      { kind: 'content' },
      { kind: 'routes' },
      { kind: 'styles', routeComponent: 'src/pages/index.astro' },
      { kind: 'styles', routeComponent: 'src/pages/nested/page.astro', attempts: 3 },
    ] as const;

    const results = await Promise.all(requests.map((request) => run.inspect(request)));

    expect(plane.wire.requests).toEqual([...requests]);
    for (const [index, result] of results.entries()) {
      expect(result.kind).toBe(requests[index]?.kind);
      expect(result.revision).toBeGreaterThan(0);
    }
    // Revisions are per-family monotonic: a second project inspect ticks.
    const again = await run.inspect({ kind: 'project' });
    expect(again.kind).toBe('project');
    expect(again.revision).toBe(2);
  });

  it('a dispatch failure passes through unchanged — the structured failure is the rejection too', async () => {
    const { run, plane } = await readyRun();
    plane.wire.nextFailure = {
      code: 'inspection-failed',
      message: 'the content inspection failed at the project adapter (seam-rejected)',
      adapterCode: 'seam-rejected',
    };

    const rejection = await rejectionOf(run.inspect({ kind: 'content' }));
    expect(rejection).toBeInstanceOf(WorkerRejectionError);
    if (rejection instanceof WorkerRejectionError) {
      expect(rejection.failure).toMatchObject({
        code: 'inspection-failed',
        adapterCode: 'seam-rejected',
      });
    }
    // The wire's own gate law (the facet contract) passes through as well.
    plane.wire.gate = 'closing';
    const gated = await rejectionOf(run.inspect({ kind: 'content' }));
    if (gated instanceof WorkerRejectionError) {
      expect(gated.failure.code).toBe('shutdown');
    } else {
      throw new Error('expected the facet shutdown rejection to pass through');
    }
  });
});

describe('typed-only admission — nothing else enters dispatch', () => {
  it('malformed requests reject structured without ever reaching the wire', async () => {
    const { run, plane } = await readyRun();
    const hostile: unknown[] = [
      null,
      'project',
      42,
      {},
      { kind: 'bogus' },
      { kind: 'project', extra: 1 },
      { kind: 'styles' },
      { kind: 'styles', routeComponent: 'src/pages/index.astro', attempts: 0 },
      { kind: 'styles', routeComponent: '/abs/pages/index.astro' },
    ];

    for (const request of hostile) {
      const rejection = await rejectionOf(run.inspect(request as never));
      if (rejection instanceof WorkerRejectionError) {
        expect(rejection.failure.code).toBe('malformed-request');
      } else {
        throw new Error(
          `expected a structured malformed-request rejection for ${JSON.stringify(request)}`,
        );
      }
    }
    expect(plane.wire.requests).toHaveLength(0);
  });

  it('after any stop began, new work rejects structured shutdown without touching the wire', async () => {
    const { run, plane } = await readyRun();
    const stopping = run.stop(); // not yet settled — the close report pends

    const rejection = await rejectionOf(run.inspect({ kind: 'project' }));
    if (rejection instanceof WorkerRejectionError) {
      expect(rejection.failure.code).toBe('shutdown');
    } else {
      throw new Error('expected the structured shutdown rejection');
    }
    expect(plane.wire.requests).toHaveLength(0);

    plane.closeWith(completeReport('stopped'));
    await stopping;
  });
});

describe('subscribe — revisioned invalidations and structured diagnostics', () => {
  const invalidation: WorkerEvent = {
    type: 'invalidation',
    families: ['routes', 'styles'],
    revision: 2,
  };
  const diagnostic: WorkerEvent = {
    type: 'diagnostic',
    level: 'warn',
    message: 'the styles inspection did not converge (it raced a watcher invalidation)',
  };

  it('forwards both event species to every subscriber, in order; unbind stops delivery', async () => {
    const { run, plane } = await readyRun();
    const first: WorkerEvent[] = [];
    const second: WorkerEvent[] = [];
    const unbindFirst = run.subscribe((event) => first.push(event));
    run.subscribe((event) => second.push(event));

    plane.wire.emit(invalidation);
    plane.wire.emit(diagnostic);
    expect(first).toEqual([invalidation, diagnostic]);
    expect(second).toEqual([invalidation, diagnostic]);

    unbindFirst();
    plane.wire.emit(invalidation);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(3);
  });

  it('a subscriber registered before the plane arrives receives its events; a throwing subscriber breaks nothing', async () => {
    const control = controllableLaunch();
    const runtime = createProjectRuntime({ launchPlane: control.launchPlane });
    const run = runtime.start({ projectRoot: HOSTILE_ROOT, devServerPort: HOSTILE_PORT });
    const received: WorkerEvent[] = [];
    run.subscribe((event) => received.push(event));

    const plane = control.arrive();
    plane.settleReady();
    await run.ready;
    run.subscribe(() => {
      throw new Error('subscriber bug');
    });

    plane.wire.emit(diagnostic);
    expect(received).toEqual([diagnostic]);
  });
});

describe('idempotent stop and crash convergence to the one report', () => {
  it('stop is idempotent: every call and closed settle the SAME report instance, one plane stop', async () => {
    const { run, plane } = await readyRun();

    const stopping = run.stop();
    plane.closeWith(completeReport('stopped'));
    const report = await stopping;

    expect(await run.stop()).toBe(report);
    expect(await run.closed).toBe(report);
    expect(plane.stopCalls).toBe(1);
  });

  it('a crash after readiness converges: closed settles the crash report, ready stays resolved, new work rejects', async () => {
    const { run, plane } = await readyRun();
    await run.ready; // readiness is settled history — a later crash never rewrites it

    plane.wire.gate = 'dead';
    plane.closeWith(completeReport('worker-crash'));

    const report = await run.closed;
    expect(report.reason).toBe('worker-crash');
    expect(await run.stop()).toBe(report);
    const rejection = await rejectionOf(run.inspect({ kind: 'routes' }));
    if (rejection instanceof WorkerRejectionError) {
      expect(rejection.failure.code).toBe('shutdown');
    } else {
      throw new Error('expected the dead-wire shutdown rejection');
    }
  });
});

describe('public-shape redaction (ADR-0006 §7 output hygiene, the AC)', () => {
  /** Key names that must never appear on a public artifact. */
  const FORBIDDEN_KEYS =
    /^(pid|port|path|process|child|handle|runner|watch|watcher|timer|socket|cwd|env|argv|executable)$/i;

  function assertRedacted(artifact: unknown, what: string): void {
    const serialized = JSON.stringify(artifact) ?? '';
    expect(findDisclosure(serialized), `${what} carries a disclosure shape`).toBeNull();
    expect(serialized, `${what} carries the raw project root`).not.toContain(HOSTILE_ROOT);
    expect(serialized, `${what} carries the dev-server port`).not.toContain(String(HOSTILE_PORT));
    const walk = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return;
      for (const [key, inner] of Object.entries(value)) {
        expect(FORBIDDEN_KEYS.test(key), `${what} carries the forbidden key "${key}"`).toBe(false);
        walk(inner);
      }
    };
    walk(artifact);
  }

  it('every public result, event, and report is disclosure-free and carries no forbidden keys', async () => {
    const { run, plane } = await readyRun();
    const results: WorkerInspectionResult[] = [
      await run.inspect({ kind: 'project' }),
      await run.inspect({ kind: 'content' }),
      await run.inspect({ kind: 'routes' }),
      await run.inspect({ kind: 'styles', routeComponent: 'src/pages/index.astro' }),
    ];
    const captured: WorkerEvent[] = [];
    run.subscribe((event) => captured.push(event));
    plane.wire.emit({ type: 'invalidation', families: ['styles'], revision: 1 });
    plane.wire.emit({
      type: 'diagnostic',
      level: 'info',
      message: 'the content inspection pass completed',
    });

    const stopping = run.stop();
    plane.closeWith(completeReport('stopped'));
    const report = await stopping;
    const incomplete: SupervisionCloseReport = {
      reason: 'startup-timeout',
      outcome: 'incomplete',
      failures: ['managed-astro-reap'],
      accounting: {
        workerReportReceived: false,
        workerCleanupComplete: true,
        workerReaped: true,
        managedAstroReaped: false,
        probesSettled: true,
        killEscalations: [],
      },
    };

    for (const [index, result] of results.entries()) {
      assertRedacted(result, `the ${result.kind} inspection result #${index}`);
    }
    assertRedacted(captured, 'the forwarded event stream');
    assertRedacted(report, 'the close report');
    assertRedacted(incomplete, 'an incomplete close report');
  });

  it('the run handle exposes exactly the five members — no supervisor, wire, child, or capability', async () => {
    const { run } = await readyRun();
    const names = Object.getOwnPropertyNames(run).sort();
    expect(names).toEqual(['closed', 'inspect', 'ready', 'stop', 'subscribe']);
    expect(findDisclosure(JSON.stringify(run) ?? '')).toBeNull();
  });

  it('every boot-error and structured-failure message is fixed-template, disclosure-free', () => {
    const codes: ProjectRunBootErrorCode[] = [
      'cancelled',
      'startup-timeout',
      'worker-crash',
      'managed-astro-crash',
      'proxy-health',
      'launch-failed',
    ];
    for (const code of codes) {
      const error = new ProjectRunBootError(code);
      expect(error.code).toBe(code);
      expect(findDisclosure(error.message)).toBeNull();
      expect(error.message).not.toContain(HOSTILE_ROOT);
    }
    for (const failure of [shutdownFailure(), malformedRequestFailure()]) {
      expect(findDisclosure(failure.message)).toBeNull();
    }
  });
});
