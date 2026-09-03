import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { BootCapability } from '@wojciechpiskorz/astroix-runtime/private-boot';
import {
  type AuthorityObservation,
  activateRequest,
  authorityObservationRequest,
  type DesktopChildReport,
  type DesktopChildRequest,
  deactivateRequest,
  hostObservationResultRequest,
  parseDesktopChildReport,
  type RegisterResult,
  registerRootRequest,
  type TransitionOutcome,
} from './child-protocol.ts';

/** The requestId-correlated report kinds — every other kind is a broadcast the host handles directly. */
type CorrelatedReport = Extract<DesktopChildReport, { readonly requestId: number }>;

/**
 * The main-side control-plane client (#243, H1; #362, H7's composition
 * extension): owns the private channel to the ONE control-plane child
 * for the whole main lifetime — confers the one-use boot capability as
 * the channel's first message (D3 #222: mint fresh per boot, send
 * exactly once, never reuse across children), correlates requests to
 * reports by id, and holds the two hard policies:
 *
 * - **No restart, ever**: the child is spawned once by the host; channel
 *   disconnect, child exit, or boot timeout mark the client LOST —
 *   terminal, surfaced, and every later call fails closed with the
 *   sanitized `control-plane-unavailable` refusal. There is no
 *   auto-restart path in this module at all (the standing no-automatic-
 *   restart law).
 * - **The ordered stop**: `stop()` disconnects the channel (the child's
 *   own fence-and-exit contract — D3), awaits its exit within the
 *   graceful bound (ADR-0006 §8's 5 s), then force-kills and awaits
 *   again. The outcome is sanitized: no exit codes, signals, or PIDs.
 *
 * Since H7 the channel is BIDIRECTIONAL: the child's composition asks
 * main to observe the authoritative window (the adoption handshake) and
 * reports the live document capability (the H4 injection's feed); main
 * answers through {@link ControlPlaneClient.hostObservation} and
 * forwards its authority observations through
 * {@link ControlPlaneClient.authorityObserve}.
 */

/** The sanitized outcome of the ordered stop. */
export type ChildStopOutcome = 'graceful' | 'forced' | 'already-exited' | 'forced-unknown';

/** Why the client is lost — surfaced, never retried. */
export type ControlPlaneLossReason = 'channel-closed' | 'child-exit' | 'boot-timeout';

/** The spawned-child handle seam (Electron `fork`/`ChildProcess` adapted by the wiring). */
export interface SpawnedChildHandle {
  send(message: unknown): boolean | null;
  disconnect(): void;
  kill(): void;
  onMessage(handler: (message: unknown) => void): void;
  onDisconnect(handler: () => void): void;
  onExit(handler: (code: number | null, signal: string | null) => void): void;
}

/** One host-observation ask, as the child's composition phrases it. */
export type HostObservationAsk =
  | { readonly kind: 'current-document'; readonly requestId: number }
  | {
      readonly kind: 'replace-top-level';
      readonly requestId: number;
      readonly sessionRef: SessionRef;
      readonly projectKey: string;
      readonly origin: string;
    };

/** The client's host callbacks — all sanitized. */
export interface ControlPlaneClientHost {
  onBooted(port: number): void;
  onLost(reason: ControlPlaneLossReason): void;
  onSessionState(sessionRef: SessionRef | null): void;
  /** The child's composition asks main to observe the authoritative window — main answers through the client. */
  onHostObservationAsk(ask: HostObservationAsk): void;
  /** The live document capability (the H4 injection's feed); null clears. */
  onDocumentCapability(webContentsId: number, capability: string | null): void;
}

/** The client surface the native host owns. */
export interface ControlPlaneClient {
  /** Resolves the composition's origin port once the child reported its boot complete; false on loss or boot timeout. */
  readonly booted: Promise<number | false>;
  /** False once the channel or child is gone. */
  readonly connected: boolean;
  registerRoot(root: string): Promise<RegisterResult>;
  activate(projectKey: string): Promise<TransitionOutcome>;
  deactivate(sessionRef: SessionRef): Promise<TransitionOutcome>;
  /** Answers one host-observation ask with the observed document identity (or the honest unobserved). */
  hostObservation(
    requestId: number,
    observed: boolean,
    document: { readonly webContentsId: number; readonly navigationId: number } | null,
  ): void;
  /** Forwards one mirror-side authority observation into the composition's document authority. */
  authorityObserve(observation: AuthorityObservation): Promise<void>;
  /** The ordered stop: disconnect → bounded graceful exit → forced kill. Idempotent. */
  stop(gracefulMs: number): Promise<ChildStopOutcome>;
}

export interface ControlPlaneClientOptions {
  readonly handle: SpawnedChildHandle;
  readonly host: ControlPlaneClientHost;
  /** The boot deadline in milliseconds; the default is 30 s. */
  readonly bootDeadlineMs?: number;
}

/** The one refused transition shape every lost-channel call answers with (the register side carries its own constant). */
const UNAVAILABLE: TransitionOutcome = {
  kind: 'refused',
  reason: 'control-plane-unavailable',
} as const;

const REGISTER_UNAVAILABLE: RegisterResult = {
  ok: false,
  code: 'control-plane-unavailable',
} as const;

/** Connects one spawned child: capability first message, then the correlation loop. */
export function connectControlPlaneChild(options: ControlPlaneClientOptions): ControlPlaneClient {
  const { handle, host } = options;
  const pending = new Map<
    number,
    {
      readonly register?: (result: RegisterResult) => void;
      readonly transition?: (outcome: TransitionOutcome) => void;
      readonly authority?: () => void;
    }
  >();
  let nextRequestId = 0;
  let lost = false;
  let bootedPort: number | false = false;
  let stopRun: Promise<ChildStopOutcome> | null = null;
  const exitWaiters: Array<() => void> = [];
  let exited = false;

  let settleBoot: (booted: number | false) => void = () => {};
  const booted = new Promise<number | false>((resolve) => {
    settleBoot = resolve;
  });

  const markLost = (reason: ControlPlaneLossReason): void => {
    if (lost) return;
    lost = true;
    for (const settle of pending.values()) {
      settle.register?.(REGISTER_UNAVAILABLE);
      settle.transition?.(UNAVAILABLE);
      settle.authority?.();
    }
    pending.clear();
    if (bootedPort === false) settleBoot(false);
    host.onLost(reason);
  };

  handle.onMessage((message) => {
    if (lost) return;
    const report = parseDesktopChildReport(message);
    if (report === null) return; // a drifted or hostile message is dropped, never parsed
    if (report.kind === 'booted') {
      bootedPort = report.port;
      settleBoot(report.port);
      host.onBooted(report.port);
      return;
    }
    if (report.kind === 'session-state') {
      host.onSessionState(report.sessionRef);
      return;
    }
    if (report.kind === 'document-capability') {
      host.onDocumentCapability(report.webContentsId, report.capability);
      return;
    }
    if (report.kind === 'observe-document') {
      host.onHostObservationAsk({ kind: 'current-document', requestId: report.requestId });
      return;
    }
    if (report.kind === 'replace-top-level') {
      host.onHostObservationAsk({
        kind: 'replace-top-level',
        requestId: report.requestId,
        sessionRef: report.sessionRef,
        projectKey: report.projectKey,
        origin: report.origin,
      });
      return;
    }
    settleCorrelated(report);
  });

  /**
   * One requestId-correlated reply onto its pending call. A correlated
   * report of the wrong kind for its request is a drifted message:
   * dropped, never half-processed — the entry survives so the real reply
   * (or the loss policy) settles the pending call.
   */
  function settleCorrelated(report: CorrelatedReport): void {
    const settle = pending.get(report.requestId);
    if (settle === undefined) return;
    if (report.kind === 'register-result' && settle.register !== undefined) {
      pending.delete(report.requestId);
      settle.register(report.result);
      return;
    }
    if (report.kind === 'transition-result' && settle.transition !== undefined) {
      pending.delete(report.requestId);
      settle.transition(report.outcome);
      return;
    }
    if (report.kind === 'authority-observation-result' && settle.authority !== undefined) {
      pending.delete(report.requestId);
      settle.authority();
    }
  }

  handle.onDisconnect(() => markLost('channel-closed'));
  handle.onExit(() => {
    exited = true;
    for (const wake of exitWaiters.splice(0)) wake();
    markLost('child-exit');
  });

  // The one-use capability: minted fresh here, conferred as the FIRST
  // channel message (D3 #222). A send that cannot go through means the
  // child never existed — the loss policy owns the surface.
  const sent = handle.send(BootCapability.mint().toWireMessage());
  if (sent === false || sent === null) {
    markLost('channel-closed');
    return makeClient();
  }

  const deadline = options.bootDeadlineMs ?? 30_000;
  const timer = setTimeout(() => {
    if (bootedPort === false) markLost('boot-timeout');
  }, deadline);
  unrefTimer(timer);

  function nextId(): number {
    nextRequestId += 1;
    return nextRequestId;
  }

  function request(
    build: (requestId: number) => DesktopChildRequest,
    settle: {
      register?: (result: RegisterResult) => void;
      transition?: (o: TransitionOutcome) => void;
      authority?: () => void;
    },
  ): void {
    if (lost) {
      settle.register?.(REGISTER_UNAVAILABLE);
      settle.transition?.(UNAVAILABLE);
      settle.authority?.();
      return;
    }
    const requestId = nextId();
    pending.set(requestId, settle);
    const sent = handle.send(build(requestId));
    if (sent === false || sent === null) {
      pending.delete(requestId);
      settle.register?.(REGISTER_UNAVAILABLE);
      settle.transition?.(UNAVAILABLE);
      settle.authority?.();
    }
  }

  function awaitExit(): Promise<void> {
    if (exited) return Promise.resolve();
    return new Promise<void>((resolve) => {
      exitWaiters.push(resolve);
    });
  }

  async function orderedStop(gracefulMs: number): Promise<ChildStopOutcome> {
    if (exited) return 'already-exited';
    handle.disconnect();
    if (await raceWithDeadline(awaitExit(), gracefulMs)) {
      return 'graceful';
    }
    handle.kill();
    if (await raceWithDeadline(awaitExit(), 2000)) {
      return 'forced';
    }
    return 'forced-unknown';
  }

  function makeClient(): ControlPlaneClient {
    return {
      booted,
      get connected() {
        return !lost;
      },
      registerRoot: (root) =>
        new Promise<RegisterResult>((resolve) => {
          request((requestId) => registerRootRequest(requestId, root), { register: resolve });
        }),
      activate: (projectKey) =>
        new Promise<TransitionOutcome>((resolve) => {
          request((requestId) => activateRequest(requestId, projectKey), { transition: resolve });
        }),
      deactivate: (sessionRef) =>
        new Promise<TransitionOutcome>((resolve) => {
          request((requestId) => deactivateRequest(requestId, sessionRef), {
            transition: resolve,
          });
        }),
      hostObservation: (requestId, observed, document) => {
        // The ask's own reply: a lost channel drops it (the child's
        // handshake waiter dies with the child), never a fabricated answer.
        if (lost) return;
        handle.send(hostObservationResultRequest(requestId, observed, document));
      },
      authorityObserve: (observation) =>
        new Promise<void>((resolve) => {
          request((requestId) => authorityObservationRequest(requestId, observation), {
            authority: resolve,
          });
        }),
      stop: (gracefulMs) => {
        stopRun ??= orderedStop(gracefulMs);
        return stopRun;
      },
    };
  }

  return makeClient();
}

/** Resolves false when the promise does not settle within `ms` (the bounded wait; never extends the bound). */
async function raceWithDeadline(settled: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
        unrefTimer(timer);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A deadline timer must never hold the process open (the `unref` guard keeps browser-ish environments happy). */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') {
    timer.unref();
  }
}
