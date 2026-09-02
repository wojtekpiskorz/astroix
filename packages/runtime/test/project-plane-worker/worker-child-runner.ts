import { appendFileSync } from 'node:fs';
import type { ProjectWorkerPlane } from '../../project-plane/worker/inspection-branches.ts';
import { bootProjectPlaneWorker } from '../../project-plane/worker/worker-child.ts';
import { workerChannel } from '../../project-plane/worker/worker-ipc.ts';
import { type BranchBehavior, fakePlane } from './plane-fakes.ts';

/**
 * The #230 process-lane child fixture (#222's control-plane-child-runner
 * idiom): a real forked child running the REAL boot gate
 * (`bootProjectPlaneWorker`) and the REAL serving loop
 * (`serveProjectWorker`) over its real private IPC channel and the real
 * `process.exit` — over the dispatch-boundary fake plane. The markers
 * prove the lifecycle ordering externally: `boot` appears only after the
 * plane factory resolved; `plane-closed` appears exactly when the owned
 * plane closed (cleanup-before-exit). A crashed or killed child never
 * writes `boot` again — the no-auto-restart assertion counts boots, never
 * restarts.
 */

interface ChildConfig {
  /** Directory receiving the marker files. */
  markerDir: string;
  /** The fake plane's per-branch behaviors (see plane-fakes). */
  behaviors?: {
    project?: BranchBehavior;
    styles?: BranchBehavior;
    content?: BranchBehavior;
    routes?: BranchBehavior;
  };
  /** Rejects the plane factory — the boot gate's failure path. */
  planeBoot?: 'fail';
  debounceMs?: number;
}

const config: ChildConfig = JSON.parse(process.argv[2] ?? '{}');

function marker(name: string): void {
  appendFileSync(`${config.markerDir}/${name}.marker`, `${Date.now()}\n`, { mode: 0o600 });
}

function createPlane(): Promise<ProjectWorkerPlane> {
  const fake = fakePlane();
  Object.assign(fake.behaviors, config.behaviors ?? {});
  return Promise.resolve({
    inspections: fake.plane.inspections,
    invalidations: fake.plane.invalidations,
    close: async () => {
      marker('plane-closed');
      await fake.plane.close();
    },
  } satisfies ProjectWorkerPlane);
}

void (async () => {
  await bootProjectPlaneWorker({
    channel: workerChannel(process),
    createPlane:
      config.planeBoot === 'fail'
        ? async () => {
            throw new Error('the composition boot failed (uncertified pair)');
          }
        : async () => {
            marker('boot');
            return createPlane();
          },
    invalidationDebounceMs: config.debounceMs ?? 0,
  });
})().catch(() => {
  // The boot gate already exited this child (74); a rejected promise here
  // carries no additional decision.
});
