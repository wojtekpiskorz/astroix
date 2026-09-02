import { createCompositionServer } from '../../astro-project-adapter/composition';
import { inspectContent } from '../../astro-project-adapter/content/inspect-content';
import { createRoutesInspector } from '../../astro-project-adapter/routes/routes-inspection';
import { createConvergedStylesInspection } from '../../astro-project-adapter/styles/convergence/converged-styles-inspection';
import type { ProjectWorkerPlane } from '../worker/inspection-branches.ts';

/**
 * The composition runtime (#230, ADR-0005 "Real configuration and
 * duplicate hooks"): boots ONE middleware-mode composition Vite server
 * over the managed project's real configuration (E1's gate-before-import
 * `createCompositionServer` — the pair certifies first, the project's
 * integrations execute here exactly as in the managed dev server) and
 * binds the four landed inspection surfaces onto it as the worker's
 * typed branches:
 *
 * - `project` — the composition seams' certified exact pair (E1);
 * - `styles` — the convergence-gated inspector (E3
 *   `createConvergedStylesInspection`), the ONE styles entry this lane
 *   wires: `route-styles.ts` stays the join's internal leg, unwired here
 *   (the #303 carried decision);
 * - `content` — E4's `inspectContent` over the composition (one fresh
 *   runner per pass, closed in `finally`);
 * - `routes` — E5's `createRoutesInspector` (bounded, abortable passes).
 *
 * The invalidation stream is E3's source over the composition watcher —
 * the raw revisioned stream the worker accumulates and publishes
 * (`invalidation-source.ts` hands exactly this lane that job).
 *
 * This module is IO composition only — every behavior lives in the
 * landed adapter surfaces; its truth is the real-install certification
 * suite (`npm run certify:adapter`), so it sits on the CC-only watchlist
 * like the adapter's own `composition.ts`. The plane contract itself is
 * `ProjectWorkerPlane`, proven by the worker's focused tests over the
 * typed-dispatch fake.
 */

/** Boots the composition runtime for one managed project root. */
export async function createCompositionRuntime(input: {
  readonly projectRoot: string;
}): Promise<ProjectWorkerPlane> {
  const composition = await createCompositionServer(input.projectRoot);
  // The ONE styles inspection import: the convergence-gated entry. Its
  // invalidation source defaults to one over this composition's watcher.
  const stylesInspector = createConvergedStylesInspection({
    server: composition.server,
    seams: composition.seams,
  });
  const routesInspector = createRoutesInspector({ composition });

  return {
    inspections: {
      project: async () => ({ certified: composition.seams.certifiedPair }),
      styles: (inspection) => stylesInspector.inspect(inspection),
      // E4's pass outcome carries its fresh-runner cleanup evidence beside
      // the result; a cleanup violation rejects the pass outright (the
      // runner-cleanup AdapterError), so the evidence needs no consumer
      // here — the property is proven, not re-checked.
      content: async () => (await inspectContent(composition)).result,
      routes: (pass) => routesInspector.inspect(pass),
    },
    invalidations: stylesInspector.invalidations,
    close: async () => {
      // Own the invalidation source's watcher bindings first, then the
      // composition server and its watcher (ADR-0005 normal stop).
      stylesInspector.invalidations.dispose();
      await composition.close();
    },
  };
}
