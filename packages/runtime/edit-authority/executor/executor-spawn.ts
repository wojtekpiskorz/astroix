import { type ChildProcess, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import type { QualifiedRuntimePin } from '../../kernel-lease/kernel-lease.ts';
import type { DomainWritePlan } from '../planning/write-plans.ts';
import type { ExecutorWireOut } from './executor-ipc.ts';
import { ExecutorFencedError, type WriteOutcome } from './write-outcomes.ts';

/**
 * The spawner side of the write-executor seam (#224, ADR-0006 §4/§6): the
 * control plane's handle over the exact disposable child it forked. This
 * is the only place `unknown` write outcomes are born — a live executor
 * always knows whether its own atomic replacement resolved, but a forced
 * termination races the commit (and the outcome reply itself), and the
 * surviving observer must report the honest state: the rename may or may
 * not have landed. Every operation the handle dispatched that has not
 * settled when the child exits resolves to `{ type: 'unknown' }` — never
 * a guess, never a pending promise outliving the executor.
 *
 * `stop` is the graceful drain: fence, wait for every accepted operation
 * to reach a terminal outcome, observe the close report and the exit —
 * the lease releases with that exit, which is what makes the next
 * session's executor acquirable. `kill` is the force path (ADR-0006
 * §4.4): immediate SIGKILL, unsettled work reported unknown, the exit
 * observed before any new authority may be granted (that sequencing is
 * the supervisor lane's composition, F4/F5 — this seam provides the
 * observation).
 */

export interface WriteExecutorHandle {
  /** Resolves when the child holds the edit-writer lease and is serving; rejects on a failed boot. */
  readonly ready: Promise<void>;
  /**
   * Dispatches one accepted domain write plan to the executor. Resolves
   * with its terminal outcome — `unknown` when the executor exits before
   * the outcome arrives. Rejects with `ExecutorFencedError` once the
   * handle has stopped or the executor has exited (never dispatched).
   */
  execute(plan: DomainWritePlan): Promise<WriteOutcome>;
  /** Graceful drain: stop control, await the close report and the exit. */
  stop(): Promise<void>;
  /** The force path: SIGKILL now; unsettled operations resolve `unknown`. */
  kill(): Promise<void>;
  /** The observed exit — the proof no live executor retains the lease. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface SpawnWriteExecutorInput {
  readonly privateStateDirectory: string;
  readonly canonicalRoot: string;
  readonly session: SessionRef;
  /** The runtime pin the child declares; dev/test compositions pass `currentRuntimePin()`. */
  readonly qualifiedRuntime?: QualifiedRuntimePin;
  /**
   * The child module to fork; defaults to this seam's sibling
   * `executor-child.ts` (the packaged runtime's entry). The process-lane
   * tests override it with their gated runner over the same boot.
   */
  readonly childModule?: string;
  /**
   * Extra child-boot config merged into the argv JSON for overridden
   * child modules (the test runners' in-flight gate directory); the
   * packaged child ignores fields it does not know. The known fields
   * above always win over anything here.
   */
  readonly childConfig?: Record<string, unknown>;
  /** Fork options passthrough (test environment injection); the channel is always IPC. */
  readonly forkOptions?: { readonly env?: NodeJS.ProcessEnv };
}

type HandleState = 'running' | 'stopping' | 'exited';

export function spawnWriteExecutor(input: SpawnWriteExecutorInput): WriteExecutorHandle {
  const childModule =
    input.childModule ?? fileURLToPath(new URL('./executor-child.ts', import.meta.url));
  const child: ChildProcess = fork(
    childModule,
    [
      JSON.stringify({
        ...(input.childConfig ?? {}),
        privateStateDirectory: input.privateStateDirectory,
        canonicalRoot: input.canonicalRoot,
        session: input.session,
        qualifiedRuntime: input.qualifiedRuntime,
      }),
    ],
    input.forkOptions,
  );

  const pending = new Map<number, (outcome: WriteOutcome) => void>();
  let nextId = 0;
  let state: HandleState = 'running';

  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  let resolveStop: (() => void) | undefined;
  const stop = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  const onExit = (): void => {
    // The executor is gone: every dispatched-but-unsettled operation is
    // honestly unknown — the rename may or may not have landed, and the
    // reply may or may not have been sent. Never a guess.
    state = 'exited';
    for (const resolve of pending.values()) resolve({ type: 'unknown' });
    pending.clear();
    rejectReady?.(new Error('the write executor exited before it was ready'));
    resolveStop?.();
  };

  child.on('message', (message: unknown) => {
    const wire = message as ExecutorWireOut;
    if (wire?.type === 'ready') {
      resolveReady?.();
      return;
    }
    if (wire?.type === 'outcome') {
      const resolve = pending.get(wire.id);
      if (resolve !== undefined) {
        pending.delete(wire.id);
        resolve(wire.outcome);
      }
      return;
    }
    if (wire?.type === 'closed') {
      resolveStop?.();
    }
  });
  child.on('exit', onExit);

  return {
    ready,
    execute: (plan) =>
      new Promise<WriteOutcome>((resolve, reject) => {
        if (state !== 'running') {
          reject(new ExecutorFencedError());
          return;
        }
        const id = nextId;
        nextId += 1;
        pending.set(id, resolve);
        const sent = child.send({ type: 'execute', id, plan });
        if (!sent) {
          // The channel was already gone: the plan never left this
          // process, nothing was accepted, admission itself failed —
          // fenced, never the maybe-landed `unknown` of settled work.
          pending.delete(id);
          reject(new ExecutorFencedError());
        }
      }),
    stop: () => {
      if (state === 'running') {
        state = 'stopping';
        child.send({ type: 'stop' });
      }
      return stop;
    },
    kill: () => {
      if (state !== 'exited') child.kill('SIGKILL');
      return stop;
    },
    exited,
  };
}
