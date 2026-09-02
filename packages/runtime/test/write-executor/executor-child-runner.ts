import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { bootWriteExecutorChild } from '../../edit-authority/executor/executor-child.ts';
import { executorChannel } from '../../edit-authority/executor/executor-ipc.ts';
import type { WriteExecutor } from '../../edit-authority/executor/write-executor.ts';
import { createWriteExecutor } from '../../edit-authority/executor/write-executor.ts';
import type { WriteOutcome } from '../../edit-authority/executor/write-outcomes.ts';
import { currentRuntimePin } from '../../kernel-lease/kernel-lease.ts';

/**
 * The #224 process-lane child fixture (the #222 runner idiom): a real
 * forked child running the REAL boot gate (`bootWriteExecutorChild` —
 * real edit-writer lease, real serving loop, real process.exit) over the
 * REAL executor core. The one test-owned interposition is the in-flight
 * gate: with `gateDir` configured, every dispatched plan parks between
 * wire admission and core execution — writing `executing-<n>.marker` and
 * waiting for `go-<n>` — so the parent holds deterministic proof an
 * operation is IN FLIGHT before it races a kill or a stop. No product
 * module contains a hook of any kind; the gate lives here, at the
 * injected `createExecutor` seam. Runs under plain Node (type stripping);
 * module paths are relative and workspace imports are type-only.
 */

interface RunnerConfig {
  privateStateDirectory: string;
  canonicalRoot: string;
  session: { runtimeEpoch: string; generation: number };
  gateDir?: string;
}

const config: RunnerConfig = JSON.parse(process.argv[2] ?? 'null');

function marker(name: string): void {
  appendFileSync(`${config.gateDir}/${name}.marker`, `${Date.now()}\n`, { mode: 0o600 });
}

/** Timed wait on the main thread without timers — deterministic, deadline-bounded (#222 idiom). */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function createExecutor(): WriteExecutor {
  const core = createWriteExecutor({
    canonicalRoot: config.canonicalRoot,
    session: config.session,
  });
  if (config.gateDir === undefined) return core;
  let sequence = 0;
  return {
    get state(): WriteExecutor['state'] {
      return core.state;
    },
    execute: (plan) =>
      new Promise<WriteOutcome>((resolve, reject) => {
        sequence += 1;
        const ticket = sequence;
        marker(`executing-${ticket}`);
        void (async () => {
          while (!existsSync(`${config.gateDir}/go-${ticket}`)) sleepSync(20);
          writeFileSync(`${config.gateDir}/passed-${ticket}.marker`, `${Date.now()}\n`, {
            mode: 0o600,
          });
          try {
            resolve(await core.execute(plan));
          } catch (error) {
            reject(error);
          }
        })();
      }),
    stop: () => core.stop(),
    closed: core.closed,
  };
}

void bootWriteExecutorChild({
  channel: executorChannel(process),
  privateStateDirectory: config.privateStateDirectory,
  canonicalRoot: config.canonicalRoot,
  session: config.session,
  qualifiedRuntime: currentRuntimePin(),
  createExecutor,
}).catch(() => {
  // The boot gate already terminated this child (contention/failure
  // exits); nothing further to decide here.
});
