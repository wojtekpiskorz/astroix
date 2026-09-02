import { buildCssIndex } from '@wojciechpiskorz/astroix-core';
import type { ProjectRuntimeSeams } from '../../composition';
import { withFreshRunner } from '../../fresh-runner';
import type { DevCssSeamEntry, ViteServerLike } from '../../seam-readers';
import { readDevCssEntries } from '../../seam-readers';
import { transformScopedStyleModules } from './client-scoped-css';
import {
  type EffectiveSelectorRecord,
  joinEffectiveSelectors,
  stylesJoinRejected,
} from './effective-selector-join';
import { readProjectCssSources } from './project-css-sources';

/**
 * The route styles join (#226, ADR-0005 `styles` inspection): one pass
 * joins the project's static source index with the effective selectors
 * of one active route — the bounded composition of the join's three
 * legs, in the managed-first order the certification proved (#225):
 *
 *   1. route CSS set — a fresh module runner imports the active route
 *      component's `virtual:astro:dev-css` module (closed in `finally`
 *      with the #206 runner discipline); the adapter takes ONLY the
 *      route order, module IDs, and URLs from it — never its content,
 *      and never a Vite handle.
 *   2. client transforms — the route's page is primed in the owning
 *      client environment, every scoped style module is transformed
 *      there, and the module graph's ownership of each transformed
 *      module is proven (`client-scoped-css.ts`).
 *   3. correspondence — the pure join correlates static and compiled
 *      blocks by index and rules by count, order, and selector
 *      identity, failing closed on every disagreement
 *      (`effective-selector-join.ts`).
 *
 * The result is revisioned and plain: `{revision, records}` data only —
 * no raw Vite handles, no compiler implementation objects (the records
 * are fresh plain objects; the postcss parse stays inside the join).
 * The revision is the styles resource's monotonic counter (ADR-0005/
 * ADR-0006 §6: every inspection result carries a monotonic resource
 * revision — the freshness contract behind grants): it advances only on
 * a fully successful join, so a failed pass never mints a revision.
 *
 * Real Astro/Vite IO composition over the probed seams — its truth is
 * the real-install certification suite (#225); the unit tests exercise
 * the composition with injected stand-ins only (coverage-tier
 * decision, #226).
 */

const SEAM_JOIN_DEV_CSS_IMPORT =
  'virtual:astro:dev-css module import for the active route component';

/** The revisioned styles join of one pass — the `styles` inspection payload shape. */
export interface EffectiveSelectorJoin {
  /** Monotonic styles-resource revision of this join (advances per successful join). */
  readonly revision: number;
  readonly records: readonly EffectiveSelectorRecord[];
}

/** One styles join pass over one active route component. */
export interface RouteStylesJoinInput {
  /** The active route's component (`src/pages/…`, `virtual:astro:routes` form). */
  readonly routeComponent: string;
}

/** The styles join surface: revisioned effective-selector joins per route. */
export interface RouteStylesJoiner {
  join(input: RouteStylesJoinInput): Promise<EffectiveSelectorJoin>;
}

/**
 * Creates the route styles joiner over a composition server's seams. The
 * joiner holds the styles-resource revision counter; each `join` runs
 * the full pass for one route component.
 */
export function createRouteStylesJoin(input: {
  readonly server: ViteServerLike;
  readonly seams: ProjectRuntimeSeams;
}): RouteStylesJoiner {
  let revision = 0;
  return {
    async join({ routeComponent }) {
      const entries = await readRouteCssEntries(input, routeComponent);
      const compiled = await transformScopedStyleModules(
        input.server.environments.client,
        entries,
        {
          routeComponent,
        },
      );
      const staticRecords = buildCssIndex(await readProjectCssSources(input.seams.projectRoot));
      const records = joinEffectiveSelectors(staticRecords, compiled, {
        requiredScopedFiles: [routeComponent],
      });
      revision += 1;
      return { revision, records };
    },
  };
}

/**
 * The route CSS set leg: a fresh runner imports the active route
 * component's dev-css virtual module. A module that will not import —
 * the missing active-route CSS module — fails closed here, sanitized,
 * with the raw import rejection kept as `cause` for the project plane's
 * own logs.
 */
async function readRouteCssEntries(
  input: { readonly server: ViteServerLike; readonly seams: ProjectRuntimeSeams },
  routeComponent: string,
): Promise<DevCssSeamEntry[]> {
  const pass = await withFreshRunner(
    {
      createServerModuleRunner: input.seams.vite.createServerModuleRunner,
      ssrEnvironment: input.server.environments.ssr,
    },
    async (runner) => {
      try {
        return await runner.import(input.seams.getDevCSSModuleName(routeComponent));
      } catch (cause) {
        throw stylesJoinRejected(
          SEAM_JOIN_DEV_CSS_IMPORT,
          'the active route component dev-css virtual module to import',
          'a module import rejection for the active route component',
          { cause },
        );
      }
    },
  );
  return readDevCssEntries(pass.result);
}
