import { pathToFileURL } from 'node:url';
import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import {
  createKernelLeaseModule,
  KernelLeaseError,
  QUALIFIED_RUNTIME_PIN,
  type QualifiedRuntimePin,
} from '../../kernel-lease/kernel-lease.ts';
import {
  EXIT_FAILURE,
  EXIT_LEASE_CONTENTION,
  executorChannel,
  serveWriteExecutor,
} from './executor-ipc.ts';
import { createWriteExecutor, type WriteExecutor } from './write-executor.ts';

/**
 * The write-executor child boot (#224, ADR-0006 §6): the exact, disposable
 * composition one project session's executor runs. Boot order is the
 * authority contract: the kernel **edit-writer lease is acquired and
 * lifetime-held before anything else exists** — a session's executor that
 * cannot take the lease (a live predecessor, an unqualified runtime)
 * never builds an executor, never serves a plan, never writes a byte,
 * and exits through the #222 contention/failure discipline. The lease
 * has no release but this process's exit, and the serving loop exits
 * only after every accepted operation is terminal — so the lease is held
 * from before the first admission until after the last outcome, exactly
 * the lifetime ADR-0006 §6 draws. A staged candidate's executor is
 * fenced by construction: it is this same composition, and it cannot
 * obtain the lease while the active executor's process lives.
 *
 * The executor factory is the one injected seam (the #230 boot-gate
 * idiom): the packaged child wires the real `createWriteExecutor`; the
 * process-lane tests fork this same boot-and-serve composition over the
 * real executor wrapped in their deterministic in-flight gate. The
 * runtime pin passes through like `bootControlPlane`'s — the packaged
 * runtime composes the qualified production pin, dev and test
 * compositions declare `currentRuntimePin()` explicitly.
 */

/** sysexits.h EX_CANTCREAT — another live process holds the edit-writer lease. */
export const EXIT_EDIT_LEASE_CONTENTION = EXIT_LEASE_CONTENTION;

export interface WriteExecutorChildInput {
  /** Directory holding the fixed private kernel-lease files. */
  readonly privateStateDirectory: string;
  /** The canonical project root this executor writes inside. */
  readonly canonicalRoot: string;
  /** The one session this executor serves. */
  readonly session: SessionRef;
  /**
   * The runtime pin this child was launched as; defaults to the
   * qualified production pin (#209) — anything else fails closed at
   * lease creation. Dev and test compositions declare
   * `currentRuntimePin()` explicitly, the `bootControlPlane` convention.
   */
  readonly qualifiedRuntime?: QualifiedRuntimePin;
  /** Builds the served executor after the lease is held; defaults to the real core. */
  readonly createExecutor?: () => WriteExecutor;
  /** The exit transition; defaults to `process.exit`. Injected by in-process tests only. */
  readonly exitProcess?: (exitCode: number) => void;
}

/**
 * Boots this write-executor child: edit-writer lease → executor →
 * serving loop. Resolves once the lease is held and the serving loop is
 * attached (the loop then owns the process until its terminal exit).
 * Every lease failure terminates the child through `exitProcess` with
 * the #222 exit discipline and rejects with the underlying error —
 * contention is exit 73, every other failure (including an unqualified
 * runtime pin) is exit 74, never a guess at contention.
 */
export function bootWriteExecutorChild(input: WriteExecutorChildInput): Promise<void> {
  const exitProcess = input.exitProcess ?? ((exitCode: number) => process.exit(exitCode));
  return new Promise<void>((resolve, reject) => {
    let leases: ReturnType<typeof createKernelLeaseModule>;
    try {
      leases = createKernelLeaseModule({
        privateStateDirectory: input.privateStateDirectory,
        qualifiedRuntime: input.qualifiedRuntime ?? QUALIFIED_RUNTIME_PIN,
      });
      leases.holdEditWriter();
    } catch (error) {
      exitProcess(error instanceof KernelLeaseError ? exitCodeForLeaseError(error) : EXIT_FAILURE);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const executor =
      input.createExecutor !== undefined
        ? input.createExecutor()
        : createWriteExecutor({ canonicalRoot: input.canonicalRoot, session: input.session });
    serveWriteExecutor({ channel: executorChannel(process), executor, exitProcess });
    resolve();
  });
}

function exitCodeForLeaseError(error: KernelLeaseError): number {
  return error.code === 'ASTROIX_KERNEL_LEASE_UNAVAILABLE'
    ? EXIT_EDIT_LEASE_CONTENTION
    : EXIT_FAILURE;
}

/** Whether this module is the executed entry (the forked child), not an import. */
function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

// The forked-entry tail: the executor's boot config arrives as argv[2]
// JSON from the exact spawner — the control plane's composition (F4/F5
// wires the packaged path); no wire request can reach this process.
if (isDirectExecution()) {
  let config: WriteExecutorChildInput | undefined;
  try {
    const parsed = JSON.parse(process.argv[2] ?? 'null') as WriteExecutorChildInput;
    if (
      typeof parsed.privateStateDirectory === 'string' &&
      typeof parsed.canonicalRoot === 'string' &&
      typeof parsed.session === 'object' &&
      parsed.session !== null
    ) {
      config = parsed;
    }
  } catch {
    // a malformed config is the boot failure below
  }
  if (config === undefined) {
    process.exit(EXIT_FAILURE);
  }
  const boot: WriteExecutorChildInput = config;
  void bootWriteExecutorChild(boot).catch(() => {
    // The boot gate already terminated this child; nothing further to decide.
  });
}
