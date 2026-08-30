import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IntegrationResolvedRoute, PaginateFunction } from 'astro';
import type { RunnableDevEnvironment, ViteDevServer } from 'vite';
import { generatePaginateFunction } from './paginate';
import { applyRenders, isProjectPageRoute, type RoutesState } from './routes';

/**
 * The background `getStaticPaths` enumeration (#119, research #118): mirrors
 * core's `RouteCache` recipe — SSR-load each prerendered single-param page
 * route's entrypoint, call its `getStaticPaths({ paginate, routePattern })`,
 * collect the rendered param values into the routes payload's `renders`.
 *
 * Cost bounds are the research's contract: cold pass ≈ 2–3 ms per dynamic
 * route (module transform dominated), warm ≈ 1 ms — so the pass is
 * debounced, lazy (boot + hook captures only), and memoized by module
 * identity: a fresh `runner.import` every pass, and a route re-runs its
 * `getStaticPaths` only when the module object changed. A naive
 * `Map<path, mod>` held across invalidations serves stale modules (verified
 * live in #118) — the identity comparison IS the invalidation.
 *
 * Failure containment per route: try/catch + a 5 s timeout → that route's
 * `renders` comes off the payload (unknown — consumers degrade to the shape
 * premise, the marker never fires on unknown). The served endpoint never
 * awaits any of this; completion pushes `astroix:routes-changed` when the
 * payload actually moved.
 */

const DEBOUNCE_MS = 400;
const ROUTE_TIMEOUT_MS = 5_000;

/** A `getStaticPaths` module as the ssr runner hands it over. */
type StaticPathsModule = {
  getStaticPaths?: (options: {
    paginate: PaginateFunction;
    routePattern: string;
  }) => Promise<unknown> | unknown;
};

/** The param values a `getStaticPaths` result actually renders — first occurrence order, non-strings skipped (paginate's first page carries `undefined`). */
export function extractRenders(
  staticPaths: Iterable<{ params: Record<string, unknown> }>,
  paramKey: string,
): string[] {
  const seen = new Set<string>();
  for (const staticPath of staticPaths) {
    const value = staticPath.params[paramKey];
    if (typeof value === 'string') seen.add(value);
  }
  return [...seen];
}

export function registerRouteEnumeration(
  server: ViteDevServer,
  options: { root: string; routes: RoutesState },
): void {
  // Core RouteCache semantics: `mod === cached.mod` is the validity check,
  // so identities (per entrypoint id) and results (per pattern) persist
  // across passes; a dev restart births new module objects, which the
  // identity check fails open on — one cold re-run, correct again.
  const lastMods = new Map<string, unknown>();
  const results = new Map<string, readonly string[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let rerun = false;

  const push = (): void => {
    server.ws.send('astroix:routes-changed', {});
  };

  const schedule = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void runPass();
    }, DEBOUNCE_MS);
  };

  // Every hook capture re-arms a pass (module identities may have moved even
  // when the projection did not) and pushes when the served projection
  // changed — the chrome's ROUTES_KEY cache has no other invalidation.
  const onCapture = (): void => {
    if (options.routes.projectionChanged) {
      options.routes.projectionChanged = false;
      push();
    }
    schedule();
  };

  const runPass = async (): Promise<void> => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      const runner = (server.environments.ssr as RunnableDevEnvironment).runner;
      for (const route of options.routes.captured) {
        if (!isEnumeratable(route)) continue;
        const entryUrl = pathToFileURL(join(options.root, route.entrypoint)).href;
        try {
          const mod = (await withTimeout(
            runner.import(entryUrl),
            ROUTE_TIMEOUT_MS,
          )) as StaticPathsModule;
          if (mod === lastMods.get(entryUrl)) continue; // identity-cached: the previous result stands
          lastMods.set(entryUrl, mod);
          const staticPaths = await withTimeout(callGetStaticPaths(mod, route), ROUTE_TIMEOUT_MS);
          results.set(route.pattern, extractRenders(staticPaths, paramKeyOf(route)));
        } catch {
          results.delete(route.pattern); // unknown — never a wrong `renders`
        }
      }
    } catch {
      // the pass itself must never reject in the background; route-level
      // failures were already contained above
    } finally {
      running = false;
    }
    if (applyRenders(options.routes, results)) push();
    if (rerun) {
      rerun = false;
      schedule();
    }
  };

  options.routes.onCapture = onCapture;
  // Boot: the hook may have captured before registration (ordering varies)
  // — run the handler once so a pending projection push is not stranded and
  // the first pass is armed either way.
  onCapture();
}

/** Prerendered single-param page routes are the payload's `renders` space — the resolver's participating shapes, minus on-demand (its `getStaticPaths` is dead code). */
function isEnumeratable(route: IntegrationResolvedRoute): boolean {
  return isProjectPageRoute(route) && route.isPrerendered && route.params.length === 1;
}

/** The `getStaticPaths` params key for a rest param drops the dots (`...slug` → `slug`). */
function paramKeyOf(route: IntegrationResolvedRoute): string {
  return route.params[0]?.replace(/^\.\.\./, '') ?? '';
}

async function callGetStaticPaths(mod: StaticPathsModule, route: IntegrationResolvedRoute) {
  const getStaticPaths = mod.getStaticPaths;
  if (typeof getStaticPaths !== 'function') {
    // core throws GetStaticPathsRequired for this project shape at render —
    // enumeration contains it the same way: unknown, not an error
    throw new Error(`route module has no getStaticPaths: ${route.entrypoint}`);
  }
  const result = await getStaticPaths({
    paginate: generatePaginateFunction(route),
    routePattern: route.pattern,
  });
  return result as Iterable<{ params: Record<string, unknown> }>;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
