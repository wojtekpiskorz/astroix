import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import type { ProjectRun } from '@wojciechpiskorz/astroix-runtime/project-runtime';

/**
 * The composition's candidate bookkeeping (#240): the dev-server port
 * each activation picked (caller-owned input, ADR-0005 — the run itself
 * never discloses it) and the in-flight run handle keyed by its
 * reserved pair, so the executor's post-commit adoption can grant the
 * origin lease and seat the run without the runtime surface ever
 * carrying either value.
 *
 * One store per composition — no module globals: the composition
 * creates it, shares it with the supervisor's `startCandidate` seam
 * (which remembers) and the executor (which reads and clears). Cleared
 * at each activation's start so a failed attempt's stragglers never
 * accumulate.
 */

export interface CandidateStore {
  /** Records one candidate's run and its dev-server port under the reserved pair. */
  remember(run: ProjectRun, port: number, ref: SessionRef): void;
  /** The run a reserved pair names, or null — adoption's lookup. */
  runOf(ref: SessionRef): ProjectRun | null;
  /** The dev-server port the pair's run's plane was told to serve on — composition-only. */
  portOf(ref: SessionRef): number;
  /**
   * Every remembered run, in remembrance order — teardown's
   * enumeration (#391): the composition's close stops the unseated
   * candidates too, never only the seated session's run.
   */
  runs(): readonly ProjectRun[];
  /** Clears the bookkeeping — every activation starts with an empty slate. */
  clear(): void;
}

/** Builds one candidate store — the composition owns its lifetime. */
export function createCandidateStore(): CandidateStore {
  const ports = new WeakMap<ProjectRun, number>();
  const runsByPair = new Map<string, ProjectRun>();
  return {
    remember: (run, port, ref) => {
      ports.set(run, port);
      runsByPair.set(pairKey(ref), run);
    },
    runOf: (ref) => runsByPair.get(pairKey(ref)) ?? null,
    portOf: (ref) => {
      const run = runsByPair.get(pairKey(ref));
      return run !== undefined ? (ports.get(run) ?? -1) : -1;
    },
    runs: () => [...runsByPair.values()],
    clear: () => runsByPair.clear(),
  };
}

/** The one pair-to-key spelling in the host — every keyed store and map uses it. */
export function pairKey(ref: SessionRef): string {
  return `${ref.runtimeEpoch}#${ref.generation}`;
}
