import { createServer as createNetServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOriginListener, type OriginListener } from '../../origin/origin-listener.ts';
import {
  createProjectRuntime,
  type ProjectRun,
  ProjectRunBootError,
} from '../../project-runtime/project-runtime.ts';
import type { ProxyHealthPrerequisite } from '../../project-runtime/proxy-health.ts';
import { createProxyHealthCheck } from '../../proxy/proxy-health.ts';
import { completeReport, type FakePlane, fakePlane } from '../project-runtime/plane-fakes.ts';
import { KEY_A, type StandInUpstream, startStandInUpstream } from './stand-ins.ts';

/**
 * The proxy-health focused legs (#233, the #310 carried inputs): the
 * REAL check over the real listener/lease/upstream pipe, injected
 * through the REAL ProjectRuntime facade's seam — no edit to
 * `project-runtime/**`, exactly the composition the future session
 * lane performs. The terminality law is the load-bearing leg: a plane
 * that dies mid-check must surface through `closed` and the eventual
 * cancellation, never as a `proxy-health` boot error.
 */

interface HealthFixture {
  readonly listener: OriginListener;
  readonly upstream: StandInUpstream;
  readonly plane: FakePlane;
  readonly health: ProxyHealthPrerequisite;
  /** The run-closed observation the check closes over — rebinds to the live run inside startRun. */
  readonly state: { runClosed: () => Promise<unknown> | null };
}

let fixture: HealthFixture | null = null;

beforeEach(async () => {
  const upstream = await startStandInUpstream();
  const listener = await createOriginListener();
  listener.grantProjectLease({
    projectKey: KEY_A,
    upstream: { host: '127.0.0.1', port: upstream.port },
  });
  const state: { runClosed: () => Promise<unknown> | null } = { runClosed: () => null };
  const health = createProxyHealthCheck({
    listener,
    projectKey: KEY_A,
    runClosed: () => state.runClosed(),
    deadlineMs: 700,
    intervalMs: 40,
  });
  fixture = { listener, upstream, plane: fakePlane(), health, state };
});

afterEach(async () => {
  const current = fixture;
  fixture = null;
  await current?.listener.close();
  await current?.upstream.close();
});

/** Starts one run over the fake plane with the real check injected — the session lane's composition. */
function startRun(): ProjectRun {
  const { plane, health, state } = fixture as HealthFixture;
  const runtime = createProjectRuntime({
    launchPlane: () => Promise.resolve(plane.supervisor),
    proxyHealth: health,
  });
  const run = runtime.start({ projectRoot: '/stand-in/root', devServerPort: 4321 });
  state.runClosed = () => run.closed;
  return run;
}

describe('createProxyHealthCheck (real listener, real facade seam)', () => {
  it('resolves over a healthy pipe — the run becomes ready and stops cleanly', async () => {
    const { plane } = fixture as HealthFixture;
    const run = startRun();
    plane.settleReady();
    await run.ready;
    const stopping = run.stop();
    plane.closeWith(completeReport('stopped')); // the fake's own law: stop settles with closed
    await stopping;
    expect(plane.stopCalls).toBe(1);
  });

  it('resolves directly when the pipe answers on the first probe', async () => {
    const { health } = fixture as HealthFixture;
    await expect(health.check({})).resolves.toBeUndefined();
  });

  it('rejects when the route is unhealthy (upstream dead, run alive) — the facade reports proxy-health', async () => {
    const { plane, upstream, listener } = fixture as HealthFixture;
    // The upstream dies but the run stays alive: a genuine proxy fault.
    const deadPort = upstream.port;
    await upstream.close();
    await listener.activeLease?.revoke();
    listener.grantProjectLease({
      projectKey: KEY_A,
      upstream: { host: '127.0.0.1', port: deadPort },
    });
    const run = startRun();
    plane.settleReady();
    const failure = await run.ready.then(
      () => {
        throw new Error('ready must not resolve');
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProjectRunBootError);
    expect((failure as ProjectRunBootError).code).toBe('proxy-health');
    // The failed prerequisite stopped the plane terminally.
    expect(plane.stopCalls).toBe(1);
    plane.closeWith(completeReport('stopped'));
    await run.closed;
  });

  it('observes the run closed settlement: a crash mid-check never misreports as proxy-health', async () => {
    const { plane, upstream } = fixture as HealthFixture;
    // The probe loop starts failing (upstream gone) and the plane
    // crashes mid-check — the terminality law's exact shape.
    await upstream.close();
    const run = startRun();
    plane.settleReady();
    // Let the check enter its retry loop, then crash the plane.
    await new Promise((resolve) => setTimeout(resolve, 100));
    plane.closeWith(completeReport('worker-crash'));
    // The check must FREEZE: no settlement of its own within a window
    // long enough that an honest rejection would have fired (the
    // deadline is 700 ms).
    let settled = false;
    await Promise.race([
      run.ready.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      ),
      new Promise((resolve) => setTimeout(resolve, 1200)),
    ]);
    expect(settled).toBe(false);
    await run.closed; // the crash surfaced here, as it must
    // The caller's stop settles the pended readiness as 'cancelled' —
    // NOT 'proxy-health'.
    const stopping = run.stop();
    plane.closeWith(completeReport('stopped'));
    const outcome = await run.ready.then(
      () => 'resolved',
      (error: unknown) => (error as ProjectRunBootError).code,
    );
    expect(outcome).toBe('cancelled');
    await stopping;
  });

  it('an abort mid-probing cancels cleanly (the caller stopped the run during the health phase)', async () => {
    const { plane, upstream } = fixture as HealthFixture;
    await upstream.close();
    const run = startRun();
    plane.settleReady();
    const stopped = run.stop();
    plane.closeWith(completeReport('stopped'));
    const outcome = await run.ready.then(
      () => 'resolved',
      (error: unknown) => (error as ProjectRunBootError).code,
    );
    expect(outcome).toBe('cancelled');
    await stopped;
  });

  it('rejects at the deadline when a LIVE upstream wedges the probe — the deadline bounds every probe', async () => {
    // Shape 1: the dev-server stand-in writes the response head and
    // never completes the body (the hanging route).
    const wedgedBody = await startStandInUpstream([
      { path: '/', status: 200, body: 'head-only', contentType: 'text/plain', hanging: true },
    ]);
    // Shape 2: a TCP server that accepts the connection and never
    // answers at all.
    const silentSockets: import('node:net').Socket[] = [];
    const wedgedSilent = createNetServer((socket) => {
      silentSockets.push(socket);
    });
    await new Promise<void>((resolve, reject) => {
      wedgedSilent.once('error', reject);
      wedgedSilent.listen(0, '127.0.0.1', () => resolve());
    });
    const silentPort = (wedgedSilent.address() as { port: number }).port;
    try {
      for (const wedgedPort of [wedgedBody.port, silentPort]) {
        const listener = await createOriginListener();
        listener.grantProjectLease({
          projectKey: KEY_A,
          upstream: { host: '127.0.0.1', port: wedgedPort },
        });
        const health = createProxyHealthCheck({
          listener,
          projectKey: KEY_A,
          runClosed: () => null, // a LIVE run: no crash, so the freeze hatch must not fire
          deadlineMs: 400,
          intervalMs: 50,
        });
        const signal = new CountingAbortSignal();
        const startedAt = Date.now();
        // Pre-fix this parked forever on a live plane (the probe never
        // settled); the fix races every probe against the remaining
        // deadline and destroys the loser. The signal carries the
        // caller's abort — the check must leave exactly the listeners
        // it found (one internal listener for the whole run, removed
        // on exit), never one per probe.
        await expect(health.check({ signal: signal as unknown as AbortSignal })).rejects.toThrow(
          'the proxy health probe did not observe a healthy project route',
        );
        expect(Date.now() - startedAt).toBeLessThan(2000);
        // Listener accounting: the check owns at most ONE listener for
        // its whole run and removes it on every exit path — never one
        // per probe (the pre-fix shape left every un-fired abort
        // listener behind on an unhealthy run).
        expect(signal.maxObservedListeners).toBeLessThanOrEqual(1);
        expect(signal.currentListeners).toBe(0);
        await listener.close();
      }
    } finally {
      await wedgedBody.close();
      for (const socket of silentSockets) socket.destroy();
      await new Promise<void>((resolve) => {
        wedgedSilent.close(() => resolve());
      });
    }
  });
});

/**
 * A counting stand-in for the check's structural signal contract — the
 * happy-dom environment's AbortSignal is not a Node EventTarget, and
 * exact add/remove accounting is the observable the listener-
 * accumulation fix needs: at most one listener for the whole check,
 * removed on every exit path.
 */
class CountingAbortSignal {
  private readonly listeners = new Set<() => void>();
  private maxListeners = 0;
  readonly aborted = false;
  get currentListeners(): number {
    return this.listeners.size;
  }
  get maxObservedListeners(): number {
    return this.maxListeners;
  }
  addEventListener(_type: string, listener: () => void): void {
    this.listeners.add(listener);
    this.maxListeners = Math.max(this.maxListeners, this.listeners.size);
  }
  removeEventListener(_type: string, listener: () => void): void {
    this.listeners.delete(listener);
  }
}
