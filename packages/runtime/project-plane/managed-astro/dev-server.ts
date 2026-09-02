/**
 * The managed dev server's supervision surfaces (#231): where it serves
 * and how its readiness is probed. This module is real network IO —
 * every fetch and timer here runs against the real dev-server child the
 * supervisor spawned — so it sits on the CC-only watchlist like the
 * plane's other IO glue; the spawn truth itself is
 * {@link ./dev-server-plan.ts} (covered tier) and the lifecycle truth is
 * the supervision process lane.
 */

export {
  ManagedDevServerPlanError,
  type ManagedDevServerPlanInput,
  managedDevServerPlan,
} from './dev-server-plan.ts';

/** Default readiness probe interval (ms). */
export const DEFAULT_PROBE_INTERVAL_MS = 100;

/** The loopback origin the managed dev server was told to serve on. */
export function managedDevServerOrigin(port: number): URL {
  return new URL(`http://127.0.0.1:${port}/`);
}

export interface ProbeManagedDevServerInput {
  readonly port: number;
  /** The path probed; defaults to `/`. */
  readonly path?: string;
  /** Aborting this signal ends the probe — every probe socket belongs to it. */
  readonly signal: AbortSignal;
  /** Retry interval (ms); defaults to {@link DEFAULT_PROBE_INTERVAL_MS}. */
  readonly intervalMs?: number;
}

/**
 * Probes the managed dev server until it answers `200` on its loopback
 * origin (`ready`) or the signal aborts (`aborted`) — the E1
 * certification idiom: readiness is the dev server actually serving, not
 * a boot log line. Connection errors and non-ok answers retry (a dev
 * server warming up refuses or errors briefly); an aborted probe never
 * throws and leaves no socket behind — the aborted fetch's body is
 * drained or cancelled on every exit path.
 */
export async function probeManagedDevServer(
  input: ProbeManagedDevServerInput,
): Promise<'ready' | 'aborted'> {
  const intervalMs = input.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const url = new URL(input.path ?? '/', managedDevServerOrigin(input.port));
  for (;;) {
    if (input.signal.aborted) return 'aborted';
    try {
      const response = await fetch(url, { signal: input.signal });
      if (response.ok) {
        await response.body?.cancel().catch(() => {
          // the socket is released either way — readiness is already proven
        });
        return 'ready';
      }
      await response.body?.cancel().catch(() => {
        // as above: never wait on an error body we will not read
      });
    } catch {
      // refused, reset, or aborted mid-flight — retry unless the abort fired
      if (input.signal.aborted) return 'aborted';
    }
    await abortableSleep(intervalMs, input.signal);
    if (input.signal.aborted) return 'aborted';
  }
}

/** Resolves after `ms`, or immediately when `signal` aborts first — the probe never outlives its sockets. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
