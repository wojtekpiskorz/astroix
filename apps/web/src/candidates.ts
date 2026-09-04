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
 * (which remembers) and the executor (which reads and clears). The
 * lifetime law (#412): ONLY an admitted activation clears — after
 * `begin`'s refusal gate, sparing its own just-remembered pair — so a
 * refused activation can never wipe a live in-flight attempt's run,
 * while a failed attempt's stragglers still never accumulate past the
 * next admitted one.
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
  /**
   * Clears every pair's bookkeeping EXCEPT the named one — the admitted
   * attempt's own slate reset (#412): its run was remembered
   * synchronously inside `begin`, so the clear that once ran before
   * `begin` (where a refused request could wipe an in-flight attempt's
   * bookkeeping) now spares exactly the pair it reserved.
   */
  clearExcept(keep: SessionRef): void;
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
    clearExcept: (keep) => {
      const keepKey = pairKey(keep);
      for (const key of runsByPair.keys()) {
        if (key !== keepKey) runsByPair.delete(key);
      }
    },
  };
}

/** The one pair-to-key spelling in the host — every keyed store and map uses it. */
export function pairKey(ref: SessionRef): string {
  return `${ref.runtimeEpoch}#${ref.generation}`;
}
