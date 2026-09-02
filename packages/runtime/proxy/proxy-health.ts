/**
 * F1's real proxy-health prerequisite (#233, carried input from #310's
 * PR thread — the documented deferral E8 left): the check that replaces
 * `satisfiedProxyHealth` behind the ProjectRuntime facade's injectable
 * seam, WITHOUT touching `project-runtime/**` (forbidden paths). It is
 * structurally the seam's shape — `check({ signal })` — so the future
 * session lane injects it through `createProjectRuntime({ proxyHealth
 * })` verbatim; the composition test in `test/proxy/` proves it against
 * the real facade.
 *
 * What "healthy" means here: one real round trip through the whole
 * pipe this lane owns — the bound listener, the launcher/project
 * virtual-host routing, the active project lease's admitted route, the
 * stream proxy, and the upstream answering. The probe requests the
 * lease's hostname through the listener's own loopback address; a
 * response the LISTENER did not synthesize (no marker header) is an
 * upstream response, i.e. health. Anything else — a listener-generated
 * 400/404/421, a 502, a refused connection — is unhealthy and retries
 * until the deadline, then rejects (the facade turns that rejection
 * into the terminal `proxy-health` boot error and stops the plane).
 *
 * THE TERMINALITY LAW (binding, from #310's thread): the check observes
 * the run's `closed` settlement ITSELF; plane death does NOT abort the
 * health signal — only the caller's `stop()` does (through the facade's
 * abort). A crash mid-check therefore FREEZES this check — it stops
 * probing and never settles — instead of rejecting: a dead plane must
 * surface through `closed` and the eventual stop-during-start
 * cancellation, never misreported as a proxy-health failure. The
 * freeze also guards the crash window: before rejecting at the
 * deadline, and between every retry, a settled `closed` wins.
 */

import { request as httpRequest } from 'node:http';
import type { OriginListener } from '../origin/origin-listener.ts';
import { ASTROIX_GENERATED_HEADER } from '../origin/virtual-hosts.ts';

/** Default bound on the whole check (the facade's health phase cannot hang startup indefinitely). */
export const DEFAULT_PROXY_HEALTH_DEADLINE_MS = 5000;
/** Default retry interval — also the crash-window granularity: a settled `closed` is observed within one interval. */
export const DEFAULT_PROXY_HEALTH_INTERVAL_MS = 200;

export interface ProxyHealthCheckOptions {
  readonly listener: OriginListener;
  /** The project whose virtual host must be admitted and answering. */
  readonly projectKey: string;
  /**
   * Observes the run's `closed` settlement — null before the run exists.
   * THE terminality input: a settled promise freezes the check (plane
   * death is the plane's own report, never a proxy-health failure).
   */
  readonly runClosed: () => Promise<unknown> | null;
  /** The natural path probed; defaults to `/`. */
  readonly probePath?: string;
  readonly deadlineMs?: number;
  readonly intervalMs?: number;
}

/** The seam's shape (structural — `ProjectRuntimeOptions.proxyHealth` accepts it as-is). */
export interface ProxyHealthCheck {
  check(input: { readonly signal?: AbortSignal }): Promise<void>;
}

export function createProxyHealthCheck(options: ProxyHealthCheckOptions): ProxyHealthCheck {
  const deadlineMs = options.deadlineMs ?? DEFAULT_PROXY_HEALTH_DEADLINE_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_PROXY_HEALTH_INTERVAL_MS;
  const hostname = `${options.projectKey}.localhost`;
  return {
    check: ({ signal }) =>
      checkHealth({
        port: options.listener.port,
        hostname,
        probePath: options.probePath ?? '/',
        runClosed: options.runClosed,
        deadlineMs,
        intervalMs,
        signal,
      }),
  };
}

async function checkHealth(input: {
  readonly port: number;
  readonly hostname: string;
  readonly probePath: string;
  readonly runClosed: () => Promise<unknown> | null;
  readonly deadlineMs: number;
  readonly intervalMs: number;
  readonly signal: AbortSignal | undefined;
}): Promise<void> {
  // The closed observation settles a flag once — a frozen check never
  // probes again, and no later failure path can outrun it.
  const closed = input.runClosed();
  let runIsClosed = false;
  if (closed !== null) void closed.then(freeze, freeze);
  function freeze(): void {
    runIsClosed = true;
  }

  const deadlineAt = Date.now() + input.deadlineMs;
  for (;;) {
    if (input.signal?.aborted === true || runIsClosed) return neverSettles();
    if (await probeOnce(input)) return;
    // The crash window: a plane that died while the probe was failing
    // settles `closed` here — freeze instead of retrying.
    await raceClosedOrInterval(closed, input.intervalMs);
    if (runIsClosed) return neverSettles();
    if (Date.now() >= deadlineAt) {
      // One final window before rejecting: a close settling concurrently
      // with the deadline must still win (setImmediate lets its flag
      // flush; a microtask race could read stale).
      await settleNow();
      if (runIsClosed) return neverSettles();
      throw new Error('the proxy health probe did not observe a healthy project route');
    }
  }
}

/** One round trip through the whole pipe; true only for an upstream-sourced response. */
function probeOnce(input: {
  readonly port: number;
  readonly hostname: string;
  readonly probePath: string;
  readonly signal: AbortSignal | undefined;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = httpRequest(
      {
        host: '127.0.0.1',
        port: input.port,
        method: 'GET',
        path: input.probePath,
        headers: { host: `${input.hostname}:${input.port}` },
        agent: false,
      },
      (response) => {
        response.resume(); // the verdict is the response's existence, never its body
        response.once('end', () =>
          resolve(response.headers[ASTROIX_GENERATED_HEADER] === undefined),
        );
      },
    );
    probe.on('error', () => resolve(false));
    if (input.signal !== undefined) {
      input.signal.addEventListener(
        'abort',
        () => {
          probe.destroy();
          resolve(false);
        },
        { once: true },
      );
    }
    probe.end();
  });
}

/** Resolves after `ms` — or as soon as the observed `closed` settles, whichever first (a null observation never blocks). */
function raceClosedOrInterval(closed: Promise<unknown> | null, ms: number): Promise<void> {
  if (closed === null) return sleep(ms);
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      resolve();
    }
    void closed.then(done, done);
  });
}

async function settleNow(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The terminality freeze: stops probing and never settles — the run's own terminal paths and the caller's stop own the outcome. */
function neverSettles(): Promise<void> {
  return new Promise<void>(() => {});
}
