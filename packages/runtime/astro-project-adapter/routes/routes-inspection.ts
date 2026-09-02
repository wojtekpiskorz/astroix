import type { CompositionServer } from '../composition';
import { withFreshRunner } from '../fresh-runner';
import { bounded, DEFAULT_WAIT_TIMEOUT_MS, enumerateRenders } from './route-enumeration';
import { readRouteMetadata } from './route-metadata';
import { type RouteInfo, toRouteInfos, withRenders } from './routes-payload';

/**
 * The routes inspection surface (#229, ADR-0005's typed `routes` request):
 * one fresh-runner pass over the composition server — the certified
 * `virtual:astro:routes` export for typed patterns, the managed
 * `getStaticPaths` behavior for enumeration — returning plain payload
 * data stamped with a monotonic revision. The inspector holds no Vite
 * handle, no runner, and no module: each pass borrows the composition's
 * seams, and the fresh-runner wrapper closes the runner on every exit
 * path (#206 discipline).
 *
 * Every runner read in the pass is bounded and abortable (review round 1):
 * the metadata import races the lifecycle signal and the per-wait bound,
 * so a hung composition fails the pass closed instead of hanging the
 * inspect, and an abort during the metadata read rejects promptly with
 * the caller's reason.
 *
 * The revision is the routes resource's freshness counter (CONTEXT.md
 * "resource revision"): it ticks once per completed pass — unchanged
 * payloads advance it too, because it is a version, not a diff signal —
 * and never moves for a pass that rejected. Cancellation is the caller's:
 * an aborted signal rejects the pass with the caller's reason, and the
 * revision stands still for it.
 */

const VIRTUAL_ROUTES_MODULE = 'virtual:astro:routes';

/** One routes inspection result: the monotonic revision and the typed payload valid at it. */
export interface RoutesInspectionResult {
  readonly revision: number;
  readonly routes: readonly RouteInfo[];
}

/** The per-project-plane routes inspector — one composition, many fresh passes. */
export interface RoutesInspector {
  inspect(input?: { readonly signal?: AbortSignal }): Promise<RoutesInspectionResult>;
}

/**
 * Creates the inspector over a booted composition server. The composition
 * is borrowed, never owned: closing it stays with the surrounding runtime
 * lifecycle that booted it (the worker lane, ADR-0005 normal stop).
 */
export function createRoutesInspector(input: {
  readonly composition: CompositionServer;
  /** Per-wait bound on every runner read in a pass; defaults to `DEFAULT_WAIT_TIMEOUT_MS`. */
  readonly waitTimeoutMs?: number;
}): RoutesInspector {
  let revision = 0;
  return {
    inspect: async (pass = {}) => {
      pass.signal?.throwIfAborted();
      const waitTimeoutMs = input.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const outcome = await withFreshRunner(
        {
          createServerModuleRunner: input.composition.seams.vite.createServerModuleRunner,
          ssrEnvironment: input.composition.server.environments.ssr,
        },
        async (runner) => {
          const metadata = readRouteMetadata(
            await bounded(
              runner.import(VIRTUAL_ROUTES_MODULE),
              pass.signal,
              waitTimeoutMs,
              new Error('the virtual routes module read exceeded its per-wait bound'),
            ),
          );
          const renders = await enumerateRenders(runner, metadata, {
            projectRoot: input.composition.seams.projectRoot,
            signal: pass.signal,
            waitTimeoutMs,
          });
          return withRenders(toRouteInfos(metadata), renders);
        },
      );
      revision += 1;
      return { revision, routes: outcome.result };
    },
  };
}
