import { pathToFileURL } from 'node:url';
import { createCompositionRuntime } from '../composition/composition-runtime.ts';
import type { ProjectWorkerPlane } from './inspection-branches.ts';
import {
  createProjectWorker,
  type ProjectWorker,
  type ProjectWorkerOptions,
} from './project-worker.ts';
import {
  EXIT_FAILURE,
  serveProjectWorker,
  type WorkerChannel,
  workerChannel,
} from './worker-ipc.ts';

/**
 * The real project-runtime worker child (#230, ADR-0005 process
 * topology): boots the composition runtime for one managed project
 * root, wraps it in the project-plane worker, and serves it over the
 * exact IPC channel the control plane forked it with. The boot gate is
 * fail-closed: a composition boot failure (uncertified pair, unresolvable
 * dependencies, seam rejection) terminates the child with
 * `EXIT_FAILURE` before any request is ever served — terminal for the
 * project run, never retried here (the spawner observes and decides,
 * E7).
 *
 * The plane factory is the one injected seam: the forked tail wires the
 * real composition runtime (`project-plane/composition/`); the
 * process-lane tests fork this same boot-and-serve composition over the
 * typed-dispatch fake. Everything else — typed dispatch, cancellation,
 * revisioned invalidations, diagnostics, cleanup-before-exit, terminal
 * crash semantics — is the same code both run.
 *
 * Delivery note: forking the real tail against unbundled sources needs
 * the packaged runtime's module resolution (ADR-0008) — the adapter's
 * internals and the core package are bundler-resolved, not raw-Node.
 * The child CONTRACT is proven over forked children by
 * `test/project-plane-worker/worker-process.test.ts`.
 */

/** The boot-and-serve composition every worker child runs. */
export async function bootProjectPlaneWorker(input: {
  readonly channel: WorkerChannel;
  /** Boots the owned plane; a rejection is the boot gate (terminal, no serving). */
  readonly createPlane: () => Promise<ProjectWorkerPlane>;
  readonly invalidationDebounceMs?: number;
  readonly stopTimeoutMs?: number;
  readonly exitProcess?: (exitCode: number) => void;
}): Promise<ProjectWorker> {
  const exitProcess = input.exitProcess ?? ((exitCode: number) => process.exit(exitCode));
  let plane: ProjectWorkerPlane;
  try {
    plane = await input.createPlane();
  } catch (error) {
    exitProcess(EXIT_FAILURE);
    throw error;
  }
  const worker = createProjectWorker({
    plane,
    invalidationDebounceMs: input.invalidationDebounceMs,
    stopTimeoutMs: input.stopTimeoutMs,
  } satisfies ProjectWorkerOptions);
  serveProjectWorker({ channel: input.channel, worker, exitProcess });
  return worker;
}

/** Whether this module is the executed entry (the forked child), not an import. */
function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

// The forked-entry tail: `{ "projectRoot": "…" }` over argv[2] — the
// project root arrives from the exact spawner's configuration, never
// from a wire request (no client-selected path channel).
if (isDirectExecution()) {
  const configArgument = process.argv[2];
  let projectRoot: string | undefined;
  try {
    const config = JSON.parse(configArgument ?? 'null') as { readonly projectRoot?: unknown };
    if (typeof config.projectRoot === 'string' && config.projectRoot.length > 0) {
      projectRoot = config.projectRoot;
    }
  } catch {
    // a malformed config is a boot failure below
  }
  if (projectRoot === undefined) {
    process.exit(EXIT_FAILURE);
  }
  const root: string = projectRoot;
  void bootProjectPlaneWorker({
    channel: workerChannel(process),
    createPlane: () => createCompositionRuntime({ projectRoot: root }),
  }).catch(() => {
    // The boot gate already terminated this child; nothing further to decide.
  });
}
