import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import type { ProjectRun } from '@wojciechpiskorz/astroix-runtime/project-runtime';

/**
 * The composition's candidate bookkeeping (#240): the dev-server port
 * each activation picked (caller-owned input, ADR-0005 — the run itself
 * never discloses it) and the in-flight run handle keyed by its
 * reserved pair, so the executor's post-commit adoption can grant the
 * origin lease and seat the run without the runtime surface ever
 * carrying either value. Composition-private; cleared at each
 * activation's start so a failed attempt's stragglers never accumulate.
 */

const ports = new WeakMap<ProjectRun, number>();
const runsByPair = new Map<string, ProjectRun>();

/** Records one candidate's run and its dev-server port under the reserved pair. */
export function rememberCandidate(run: ProjectRun, port: number, ref: SessionRef): void {
  ports.set(run, port);
  runsByPair.set(pairKey(ref), run);
}

/** The run a reserved pair names, or null — adoption's lookup. */
export function candidateRun(ref: SessionRef): ProjectRun | null {
  return runsByPair.get(pairKey(ref)) ?? null;
}

/** The dev-server port a run's plane was told to serve on — composition-only. */
export function runPort(run: ProjectRun): number {
  return ports.get(run) ?? -1;
}

/** Clears the bookkeeping — every activation starts with an empty slate. */
export function clearCandidates(): void {
  runsByPair.clear();
}

function pairKey(ref: SessionRef): string {
  return `${ref.runtimeEpoch}#${ref.generation}`;
}
