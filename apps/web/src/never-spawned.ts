import type { ProjectRun } from '@wojciechpiskorz/astroix-runtime/project-runtime';

/**
 * A run that was never spawned — the E8 never-spawned law, converged
 * for the composition's two defect paths (a vanished registry record at
 * candidate start; a seat whose run was never registered at adoption).
 * Nothing existed, so nothing failed to clean: the close report is
 * explicitly complete, readiness is the anchored rejection, and the
 * message names the defect that minted it.
 */

export function neverSpawnedRun(message: string): ProjectRun {
  const failure = new Error(message);
  const ready = Promise.reject(failure);
  ready.catch(() => {}); // anchored: the attempt surfaces it, the composition never hangs
  const closed = Promise.resolve({
    reason: 'cancelled',
    outcome: 'complete',
    failures: [],
    accounting: {
      workerReportReceived: false,
      workerCleanupComplete: true,
      workerReaped: false,
      managedAstroReaped: false,
      probesSettled: true,
      killEscalations: [],
    },
  } as const);
  return {
    ready,
    inspect: () => Promise.reject(failure),
    subscribe: () => () => {},
    stop: () => closed,
    closed,
  };
}
