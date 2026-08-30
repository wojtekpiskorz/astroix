import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IntegrationResolvedRoute, PaginateFunction } from 'astro';
import { createServerModuleRunner, type ViteDevServer } from 'vite';
import {
  createContentSignalClassifier,
  createLoaderCommitClassifier,
  pushToChrome,
} from './content-signal';
import { generatePaginateFunction } from './paginate';
import { applyRenders, isProjectPageRoute, type RoutesState } from './routes';

/**
 * The background `getStaticPaths` enumeration (#119, research #118): mirrors
 * core's dev recipe — load each prerendered single-param page route's
 * entrypoint in the ssr environment, call its
 * `getStaticPaths({ paginate, routePattern })`, collect the rendered param
 * values into the routes payload's `renders`.
 *
 * Freshness rides the codebase's stateless-doctrine runner (content.ts): a
 * NEW `createServerModuleRunner` per pass, nothing held between passes —
 * and closed when the pass settles, because each runner's transport pins a
 * `send` listener on the ssr hot channel (#146). The long-lived
 * `environments.ssr.runner` cannot serve this pass — its cached
 * module bindings never see content commits (verified live on astro@7.2.7:
 * after a content edit, a direct `runner.import('astro:content')` keeps
 * returning the old entries forever, while dev requests go fresh through
 * per-request runners; the module-identity memo from the research's
 * RouteCache mirroring is therefore not just unnecessary here — on the
 * shared runner it is wrong). A fresh runner re-evaluates against the
 * module graph's transform cache: route edits are seen (vite invalidated
 * the transform), content commits are seen (the evaluation reads live
 * data), warm passes stay ms-scale.
 *
 * Cadence: debounced (400 ms), lazy (boot + hook captures + srcDir content
 * signals), never blocking a request. Content file events race the loader's
 * data commit (verified: a pass right after the event reads the previous
 * commit), so a content signal re-runs the pass twice more, 2 s apart —
 * loader commits slower than ~4 s degrade to the next real event, the same
 * stale-window class dev renders have before the loader syncs.
 *
 * Failure containment per route: try/catch + a 5 s timeout → that route's
 * `renders` comes off the payload (unknown — consumers degrade to the shape
 * premise, the marker never fires on unknown). The served endpoint never
 * awaits any of this; completion pushes `astroix:routes-changed` when the
 * payload actually moved.
 *
 * This subscription is also where `astroix:content-synced` is pushed
 * (#133): astro's own content event rides the ssr environment's hot channel
 * and never reaches the client chrome (verified live on astro@7.2.7), so
 * the chrome's collections/schema caches have no other external-edit
 * invalidation. Both the shared srcDir content signal and the loader's
 * data-store write (the post-commit half — the loader debounces the store
 * write 500 ms) push immediately, labeled with the leg that fired (#155) —
 * the chrome, not a server-side grace, sequences the loader leg's refetch
 * after the canvas's post-commit full-reload render (see
 * synced-invalidation.ts on the client side).
 */

const DEBOUNCE_MS = 400;
const CONTENT_FOLLOWUP_MS = 2_000;
const CONTENT_FOLLOWUPS = 2;
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
  options: { root: string; srcDir: string; routes: RoutesState },
): void {
  const isContentSignal = createContentSignalClassifier(options);
  const isLoaderCommit = createLoaderCommitClassifier(options.root);
  const results = new Map<string, readonly string[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let rerun = false;
  let contentFollowups = 0;

  const push = (): void => {
    pushToChrome(server, 'astroix:routes-changed');
  };

  const schedule = (delay = DEBOUNCE_MS): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void runPass();
    }, delay);
  };

  // Every hook capture re-arms a pass (route edits invalidate transforms,
  // the fresh runner sees them) and pushes when the served projection
  // changed — the chrome's ROUTES_KEY cache has no other invalidation.
  const onCapture = (changed: boolean): void => {
    if (changed) push();
    schedule();
  };

  // The content signal (shared classification, content-signal.ts): a srcDir
  // file event that is neither a captured route entrypoint (the fresh
  // runner already reads those as transformed) nor css is treated as
  // content moving — the pass re-runs now and twice more to out-wait the
  // loader's data commit. Both that signal and the loader's store write
  // push `astroix:content-synced` labeled with their leg (see the module
  // doc); the store write re-arms nothing — the enumeration cadence is
  // #119's, unchanged.
  const onFileEvent = (file: string): void => {
    if (isLoaderCommit(file)) {
      pushToChrome(server, 'astroix:content-synced', 'loader');
      return;
    }
    if (!isContentSignal(file)) return;
    pushToChrome(server, 'astroix:content-synced', 'srcdir');
    contentFollowups = CONTENT_FOLLOWUPS;
    schedule();
  };
  for (const event of ['add', 'change', 'unlink'] as const) {
    server.watcher.on(event, onFileEvent);
  }

  const runPass = async (): Promise<void> => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    let runner: ReturnType<typeof createServerModuleRunner> | null = null;
    try {
      runner = createServerModuleRunner(server.environments.ssr);
      for (const route of options.routes.captured) {
        if (!isEnumeratable(route)) continue;
        const entryUrl = pathToFileURL(join(options.root, route.entrypoint)).href;
        try {
          const mod = (await withTimeout(
            runner.import(entryUrl),
            ROUTE_TIMEOUT_MS,
          )) as StaticPathsModule;
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
      // close() drops the transport's `send` listener (one leaked per pass
      // otherwise, #146); cleanup failure must not reject the background pass
      await runner?.close().catch(() => {});
      running = false;
    }
    if (applyRenders(options.routes, results)) push();
    if (contentFollowups > 0) {
      // the loader's data commit may still be in flight — read again after
      // it, until the follow-ups run out
      contentFollowups -= 1;
      schedule(CONTENT_FOLLOWUP_MS);
    } else if (rerun) {
      rerun = false;
      schedule();
    }
  };

  options.routes.onCapture = onCapture;
  // Boot: arm the first pass. No push to replay — a pre-registration capture
  // predates the server listening, so no client could have missed it; every
  // capture after registration arrives as a real onCapture call.
  onCapture(false);
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
