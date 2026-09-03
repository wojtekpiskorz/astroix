import { isCertifiedPair, uncertifiedPairError } from '../astro-project-adapter/certified-pair.ts';
import { resolveInstalledPair } from '../astro-project-adapter/installed-pair.ts';
import { managedDevServerPlan } from '../project-plane/managed-astro/dev-server-plan.ts';
import {
  createProjectPlaneSupervisor,
  type PlaneSupervisorOptions,
  type ProjectPlaneSupervisor,
  workerSpawnPlan,
} from '../project-plane/supervision/plane-supervisor.ts';

/**
 * The production plane launch (#232): the facade's default launcher,
 * composing the landed E7 surfaces verbatim — nothing here supervises,
 * dispatches, or closes on its own. Both siblings' spawn plans carry the
 * same ADR-0008 shape (one Node executable override for both children,
 * the sibling symmetry E7 pinned), the supervisor spawns and retains
 * them, and the facade binds inspection and events to the supervisor's
 * worker-wire facet — THE supervised worker, never another.
 *
 * This module is real process IO composition (canonical root resolution
 * and the project's own astro CLI lookup happen in the plans; the
 * supervisor spawns both children) — watchlist tier like the plane's
 * other IO glue, its truth the supervision process lane
 * (`test/managed-astro/**`, #231/#309) over the same ingredients.
 */
export interface LaunchManagedPlaneInput {
  /** The managed project root; canonicalized inside both spawn plans. */
  readonly projectRoot: string;
  /** The loopback port the managed dev server serves on (the caller's port discipline). */
  readonly devServerPort: number;
  /**
   * The Node executable for BOTH children; defaults to the control
   * plane's own `process.execPath` (the bundled stock Node in the
   * packaged runtime, ADR-0008 — H2 #244 rebases it).
   */
  readonly nodeExecutable?: string;
  /**
   * Node CLI flags placed before the worker module — the E6 process-lane
   * disclosure: a dev-checkout control plane running raw Node supplies
   * its bundler-resolution `--import` register here; the packaged
   * runtime's rebased entry needs none.
   */
  readonly workerExecArgv?: readonly string[];
  /** Supervisor bounds passthrough; E7's ADR-0006 §8 defaults apply otherwise. */
  readonly bounds?: ManagedPlaneBounds;
}

/** The supervisor bounds a launcher may tune — E7's ADR-0006 §8 defaults govern anything unset. */
export type ManagedPlaneBounds = Partial<
  Pick<
    PlaneSupervisorOptions,
    | 'startupTimeoutMs'
    | 'stopTimeoutMs'
    | 'termGraceMs'
    | 'killReapMs'
    | 'probeIntervalMs'
    | 'readinessPath'
  >
>;

/**
 * Launches one supervised managed plane: the ADR-0005 pair pre-flight
 * first, then both exact-child spawn plans from the managed project's
 * own installation, then the plane supervisor — the sibling pair
 * lifecycle (readiness ok-gate, crash-terminal, ordered graceful stop,
 * one recursive close report) and the worker-wire facet (typed dispatch
 * + events) are the supervisor's, unchanged.
 */
export async function launchManagedPlane(
  input: LaunchManagedPlaneInput,
): Promise<ProjectPlaneSupervisor> {
  // The compatibility pre-flight (#319, ADR-0005: an uncertified pair
  // "fails before project config executes"): the adapter's own pair
  // modules, run in the control plane BEFORE any child is spawned. An
  // uncertified pair rejects the launch with the adapter's
  // `uncertified-pair` origin — detected pair, certified pairs, rejected
  // contract — which the facade's boot-error admission maps to the
  // certification code, so the session layer reports the certification
  // category instead of folding the failure into a launch shape. The
  // worker's own E1 gate inside the composition stays the enforcement;
  // this pre-flight is the reporting path, and it fails earlier — no
  // child is ever spawned for a doomed run. A dependency that does not
  // resolve rejects here too and fails closed as `launch-failed`.
  const detected = await resolveInstalledPair(input.projectRoot);
  if (!isCertifiedPair(detected)) {
    throw uncertifiedPairError(detected);
  }
  const [worker, managedAstro] = await Promise.all([
    workerSpawnPlan({
      projectRoot: input.projectRoot,
      nodeExecutable: input.nodeExecutable,
      execArgv: input.workerExecArgv,
    }),
    managedDevServerPlan({
      projectRoot: input.projectRoot,
      port: input.devServerPort,
      nodeExecutable: input.nodeExecutable,
    }),
  ]);
  return createProjectPlaneSupervisor({
    worker,
    managedAstro,
    devServerPort: input.devServerPort,
    ...input.bounds,
  });
}
