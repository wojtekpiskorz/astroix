import type { ProjectWorker, WorkerCloseReport, WorkerStopReason } from './project-worker.ts';
import type { WorkerEvent } from './worker-events.ts';
import { branchFailure, malformedRequestFailure, WorkerRejectionError } from './worker-failure.ts';
import { isWorkerInspectionRequest, type WorkerInspectionResult } from './worker-request.ts';

/**
 * The control-plane ↔ worker-child channel (#230, ADR-0005 process
 * topology; the project-plane analogue of `private-boot/private-ipc.ts`):
 * the exact forked child's IPC channel carrying ONLY typed wire
 * messages — inspection requests in, results/failures and public events
 * out, one stop control, and the close report. No capability material,
 * no environment channel, no HTTP surface exists here (the worker holds
 * no authority; its boundary is failure and lifecycle, not trust —
 * ADR-0004).
 *
 * `serveProjectWorker` is the child's single-shot serving loop: it
 * validates every inbound message against the closed wire union (an
 * unknown message is a protocol violation — terminal crash, never
 * guessed at), forwards the worker's events, and owns the terminal exit
 * semantics: every closing path runs the worker's stop FIRST, sends the
 * close report if the channel still stands, and only then exits —
 * cleanup before exit, exactly once, with no restart anywhere (a later
 * `closed` is the spawner's decision, E7).
 */

/** sysexits.h exits for the worker child (the control-plane boot convention). */
/** Clean stop or disconnect with complete cleanup (the fenced-shutdown analogue of #222). */
export const EXIT_OK = 0;
/** Internal crash path (EX_SOFTWARE): a serving bug or a forced crash exit. */
export const EXIT_CRASH = 70;
/** Boot failure or incomplete cleanup (EX_IOERR) — fail closed, never contention. */
export const EXIT_FAILURE = 74;
/** Wire protocol violation (EX_PROTOCOL): a message outside the closed union. */
export const EXIT_PROTOCOL = 76;

/**
 * The channel subset the serving loop consumes; `process` in a forked
 * child satisfies this structurally, `workerChannel()` adapts it.
 */
export interface WorkerChannel {
  /** False once the other end closed or was disconnected. */
  readonly connected: boolean;
  /** Sends one JSON message; false/null when the channel is gone. */
  send(message: unknown): boolean | null;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'disconnect', listener: () => void): unknown;
  removeListener(event: 'message', listener: (message: unknown) => void): unknown;
  removeListener(event: 'disconnect', listener: () => void): unknown;
}

/**
 * Adapts this process's IPC channel (a forked child) to the seam. Throws
 * when the process has no IPC channel — a process without one was never
 * the exact worker child a control plane spawned.
 */
export function workerChannel(nativeProcess: NodeJS.Process): WorkerChannel {
  if (typeof nativeProcess.send !== 'function') {
    throw new TypeError('this process has no worker IPC channel (not a spawned child)');
  }
  return nativeProcess as unknown as WorkerChannel;
}

/** The closed inbound wire union: typed inspections in, one stop control. */
export type WorkerWireIn =
  | { readonly type: 'inspect'; readonly id: number; readonly request: unknown }
  | { readonly type: 'stop' };

/** The closed outbound wire union: correlated results, public events, the close report. */
export type WorkerWireOut =
  | {
      readonly type: 'inspect-result';
      readonly id: number;
      readonly ok: true;
      readonly result: WorkerInspectionResult;
    }
  | {
      readonly type: 'inspect-result';
      readonly id: number;
      readonly ok: false;
      readonly failure: WorkerRejectionError['failure'];
    }
  | { readonly type: 'event'; readonly event: WorkerEvent }
  | { readonly type: 'closed'; readonly report: WorkerCloseReport };

/** Whether `value` is one of the two inbound wire messages (the request interior validates separately, at dispatch). */
export function isWorkerWireIn(value: unknown): value is WorkerWireIn {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'stop') return Object.keys(record).length === 1;
  if (record.type !== 'inspect') return false;
  return (
    Object.keys(record).length === 3 &&
    typeof record.id === 'number' &&
    Number.isInteger(record.id) &&
    record.id >= 0
  );
}

export interface ServeProjectWorkerInput {
  readonly channel: WorkerChannel;
  readonly worker: ProjectWorker;
  /** The exit transition; defaults to `process.exit`. Injected by in-process tests only. */
  readonly exitProcess?: (exitCode: number) => void;
}

/**
 * Serves the worker over its private channel until the terminal exit.
 * Every close path funnels through the worker's single `closed`
 * settlement: stop control → outcome exit; channel disconnect → terminal
 * stop; wire violation → forced-protocol crash exit. After the exit the
 * loop is dead — nothing re-boots (no-auto-restart is structural).
 */
export function serveProjectWorker(input: ServeProjectWorkerInput): void {
  const exitProcess = input.exitProcess ?? ((exitCode: number) => process.exit(exitCode));
  let exited = false;
  let forcedExitCode: number | null = null;

  const exitOnce = (exitCode: number): void => {
    if (exited) return;
    exited = true;
    exitProcess(exitCode);
  };

  const send = (message: WorkerWireOut): void => {
    if (exited || !input.channel.connected) return;
    input.channel.send(message);
  };

  // A forced exit code (crash, protocol violation) survives even a
  // completed-cleanup report; otherwise the report's outcome decides.
  input.worker.closed.then((report) => {
    send({ type: 'closed', report });
    exitOnce(forcedExitCode ?? exitCodeFor(report));
  });

  const terminate = (reason: WorkerStopReason, forcedCode: number | null): void => {
    if (exited) return;
    forcedExitCode ??= forcedCode;
    void input.worker.stop(reason);
  };

  const onMessage = (message: unknown): void => {
    if (exited) return;
    if (!isWorkerWireIn(message)) {
      // A message outside the closed wire union is a protocol drift in
      // the spawning control plane — terminal, never guessed at.
      terminate('crash', EXIT_PROTOCOL);
      return;
    }
    if (message.type === 'stop') {
      terminate('stopped', null);
      return;
    }
    void serveInspect(message.id, message.request);
  };

  const serveInspect = async (id: number, request: unknown): Promise<void> => {
    if (!isWorkerInspectionRequest(request)) {
      send({ type: 'inspect-result', id, ok: false, failure: malformedRequestFailure() });
      return;
    }
    try {
      send({ type: 'inspect-result', id, ok: true, result: await input.worker.dispatch(request) });
    } catch (error) {
      if (error instanceof WorkerRejectionError) {
        send({ type: 'inspect-result', id, ok: false, failure: error.failure });
        return;
      }
      // dispatch maps every failure; an unstructured rejection here is a
      // serving bug — the parent gets its answer, then the child dies.
      send({
        type: 'inspect-result',
        id,
        ok: false,
        failure: branchFailure(request.kind, error),
      });
      terminate('crash', EXIT_CRASH);
    }
  };

  const onDisconnect = (): void => {
    // The parent is gone: terminal for this worker, the fenced-exit
    // analogue — cleanup, then exit (never a restart).
    terminate('disconnect', null);
  };

  input.channel.on('message', onMessage);
  input.channel.on('disconnect', onDisconnect);
  if (!input.channel.connected) onDisconnect();

  input.worker.subscribe((event) => {
    send({ type: 'event', event });
  });
}

function exitCodeFor(report: WorkerCloseReport): number {
  return report.outcome === 'complete' ? EXIT_OK : EXIT_FAILURE;
}
