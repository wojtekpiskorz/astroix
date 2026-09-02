import type { WorkerEvent } from '../worker/worker-events.ts';
import { shutdownFailure, WorkerRejectionError } from '../worker/worker-failure.ts';
import { isWorkerWireIn, type WorkerChannel, type WorkerWireIn } from '../worker/worker-ipc.ts';
import type { WorkerInspectionRequest, WorkerInspectionResult } from '../worker/worker-request.ts';

/**
 * The supervised worker-wire facet (#308, the E8 STOP seam): the plane
 * supervisor's exposed view of the worker child's private IPC wire —
 * E6's structural `WorkerChannel` (imported, never re-declared) plus the
 * parent-side dispatch/subscribe conveniences, so the project-runtime
 * facade binds `inspect` and `subscribe` to THE supervised worker — the
 * one child the supervisor spawned and retains (divergent revisions from
 * any other worker would break the revision contract).
 *
 * The two consumer id regimes are INDEPENDENT by contract: dispatch()
 * allocates upward from FIRST_CONSUMER_WIRE_ID with no ceiling, a raw
 * channel client picks its ids by hand, and neither allocator sees the
 * other — a raw id colliding with a live dispatch() id would settle the
 * wrong promise. Raw consumers own that collision discipline (the same
 * law as D5's executor raw channel).
 *
 * The id reservation is honest and one-way: the supervisor's readiness
 * probe owns wire id {@link SUPERVISOR_PROBE_WIRE_ID}, the `stop`
 * control, and the `closed` report — none of them cross the facet, in
 * either direction. Consumer traffic uses ids ≥
 * {@link FIRST_CONSUMER_WIRE_ID}, allocated by `dispatch()` or supplied
 * by a raw client through `send()`; a message attempting the
 * supervisor's reserved traffic is refused (`send` → false) rather than
 * forwarded. The facet dies with the child: `connected` falls false,
 * `send` reports false, and every in-flight dispatch settles with the
 * structured shutdown failure (the E6 `WorkerRejectionError` species) —
 * never a dangling promise, never a raw error, and no `ChildProcess`,
 * PID, or port ever crosses the surface. No new transport, no restart
 * semantics: those stay the supervisor's alone.
 */

/** The wire id the supervisor's own readiness probe rides (E6's wire: integer ≥ 0). */
export const SUPERVISOR_PROBE_WIRE_ID = 0;

/** The first wire id consumer traffic may use — derived from the probe's reservation, never a second constant. */
export const FIRST_CONSUMER_WIRE_ID = SUPERVISOR_PROBE_WIRE_ID + 1;

/**
 * The supervised worker's wire as a consumer binds it: E6's channel
 * surface (for a D5-idiom raw client) plus correlated typed dispatch
 * and event subscription.
 */
export interface SupervisedWorkerWire extends WorkerChannel {
  /**
   * Dispatches one typed inspection over the supervised wire (a consumer
   * id ≥ 1, allocated here) and settles with its correlated result.
   * Rejects with `WorkerRejectionError` for a failed answer and with the
   * structured `shutdown` failure once any close path began or the
   * channel died — never dangles.
   */
  dispatch(request: WorkerInspectionRequest): Promise<WorkerInspectionResult>;
  /** Subscribes to the worker's public `event` frames; the return unbinds. */
  subscribe(listener: (event: WorkerEvent) => void): () => void;
}

/** What the supervisor supplies the facet: the child's channel, its death, and the plane's closing gate. */
export interface SupervisedWireSource {
  /** The worker child's IPC channel, already adapted to E6's structural seam. */
  readonly channel: WorkerChannel;
  /** Resolves once the worker child is gone (exit or spawn error) — the facet dies with it. */
  readonly gone: Promise<void>;
  /** True once any supervisor close path began — consumer dispatches reject as shutdown from that instant. */
  readonly closing: () => boolean;
}

/** One in-flight consumer dispatch, awaiting its correlated answer. */
interface PendingDispatch {
  readonly resolve: (result: WorkerInspectionResult) => void;
  readonly reject: (error: unknown) => void;
}

/** A consumer's `inspect` — the wire union minus the supervisor's reserved `stop` and probe id. */
type ConsumerInspect = Extract<WorkerWireIn, { readonly type: 'inspect' }>;

/**
 * Builds the facet over the supervised channel. Pure wiring over the
 * structural seam (the same interface the child side adapts) — its
 * truth is the supervision process lane over the real supervisor and
 * stand-in children, with the branch matrix pinned by the unit fakes.
 */
export function createSupervisedWorkerWire(source: SupervisedWireSource): SupervisedWorkerWire {
  const wireOutListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const eventListeners = new Set<(event: WorkerEvent) => void>();
  const pending = new Map<number, PendingDispatch>();
  let nextId = FIRST_CONSUMER_WIRE_ID;
  let dead = false;

  const shutdownRejection = (): WorkerRejectionError => new WorkerRejectionError(shutdownFailure());

  const settleInFlightAsShutdown = (): void => {
    for (const entry of pending.values()) entry.reject(shutdownRejection());
    pending.clear();
  };

  // Channel death is observed twice on purpose — the child's IPC
  // `disconnect` and the supervisor's own exit observation (`gone`) —
  // whichever fires first settles every in-flight dispatch: no send
  // ever dangles past the worker it was addressed to.
  const markDead = (): void => {
    if (dead) return;
    dead = true;
    settleInFlightAsShutdown();
    for (const listener of disconnectListeners) listener();
  };
  source.gone.then(markDead);
  source.channel.on('disconnect', markDead);

  const onWireOut = (message: unknown): void => {
    const wire = message as { readonly type?: unknown; readonly id?: unknown } | null;
    if (wire?.type === 'closed') return; // the close report is the supervisor's
    if (wire?.type === 'inspect-result' && wire.id === SUPERVISOR_PROBE_WIRE_ID) {
      return; // the probe's answer is the supervisor's
    }
    if (wire?.type === 'inspect-result') {
      settleCorrelated(message);
    } else if (wire?.type === 'event') {
      // The payload rides unvalidated by design: the worker child is the
      // trusted producer of its own public events (E6 composes them from
      // closed shapes on the child side, equally unvalidated outbound) —
      // a hostile child is outside this wire's threat model.
      for (const listener of eventListeners)
        listener((message as { readonly event: WorkerEvent }).event);
    }
    for (const listener of wireOutListeners) listener(message);
  };

  /** Settles one correlated answer, when its dispatch is pending — the frame still reaches raw listeners below. */
  const settleCorrelated = (message: unknown): void => {
    const wire = message as {
      readonly type: 'inspect-result';
      readonly id: number;
      readonly ok: boolean;
      readonly result?: WorkerInspectionResult;
      readonly failure?: WorkerRejectionError['failure'];
    };
    const entry = pending.get(wire.id);
    if (entry === undefined) return;
    pending.delete(wire.id);
    if (wire.ok === true && wire.result !== undefined) entry.resolve(wire.result);
    else entry.reject(new WorkerRejectionError(wire.failure ?? shutdownFailure()));
  };

  source.channel.on('message', onWireOut);

  return {
    get connected(): boolean {
      return !dead && source.channel.connected;
    },
    send(message: unknown): boolean | null {
      // The gate is the reservation: only the consumer slice of the wire
      // union passes. `stop` is the supervisor's control, id 0 its
      // probe's, and anything outside the union would be a protocol
      // violation the child treats as terminal — a consumer bug must not
      // kill the supervised worker. Refusal is channel-shaped: false,
      // never a throw.
      if (dead || !source.channel.connected || !isConsumerInspect(message)) return false;
      return source.channel.send(message) ?? false;
    },
    on(event, listener) {
      if (event === 'message') wireOutListeners.add(listener);
      else disconnectListeners.add(listener as () => void); // the seam registers () => void for 'disconnect'
    },
    removeListener(event, listener) {
      if (event === 'message') wireOutListeners.delete(listener);
      else disconnectListeners.delete(listener as () => void);
    },
    dispatch: (request) =>
      new Promise<WorkerInspectionResult>((resolve, reject) => {
        if (dead || source.closing() || !source.channel.connected) {
          reject(shutdownRejection());
          return;
        }
        const id = nextId;
        nextId += 1;
        pending.set(id, { resolve, reject });
        const neverSent = (): void => {
          pending.delete(id);
          reject(shutdownRejection());
        };
        // The executor-spawn backpressure law (D5): `send() === false`
        // ALONE is backpressure — the message is queued and will be
        // delivered — so the dispatch stays pending. Only false on a
        // channel that is no longer connected is a never-sent, and a
        // synchronous THROW is the never-sent too — a channel
        // implementation may refuse by throwing inside the exit race,
        // where the message never left this process; both reject
        // structured, never a raw error. Every other death path is
        // settled by `markDead`.
        let sent: boolean | null = false;
        try {
          sent = source.channel.send({ type: 'inspect', id, request });
        } catch {
          neverSent();
          return;
        }
        if (sent === false && !source.channel.connected) neverSent();
      }),
    subscribe(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
  };
}

/**
 * Whether `message` is consumer wire traffic: a typed `inspect` whose id
 * sits above the supervisor's probe reservation.
 */
function isConsumerInspect(message: unknown): message is ConsumerInspect {
  return (
    isWorkerWireIn(message) && message.type === 'inspect' && message.id >= FIRST_CONSUMER_WIRE_ID
  );
}
