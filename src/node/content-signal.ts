import { sep } from 'node:path';
import type { ViteDevServer } from 'vite';
import { toRelative } from './rest';
import type { RoutesState } from './routes';

/**
 * The content signal, shared (#133): the one classification every watcher
 * subscriber that needs "content may have moved" consumes — today the
 * enumeration re-arm (route-enumeration.ts, #119) and the
 * `astroix:content-synced` push — so the predicate cannot drift between
 * them. A srcDir file event that is neither a captured route entrypoint
 * (route edits reach the enumeration pass as transforms) nor css
 * (watch-sync's territory). add/unlink matter as much as change (entries
 * are created and deleted, not only edited).
 */
export interface ContentSignalScope {
  root: string;
  srcDir: string;
  routes: RoutesState;
}

export function createContentSignalClassifier(
  scope: ContentSignalScope,
): (file: string) => boolean {
  // astro hands srcDir as a URL with a trailing slash — strip it or the
  // prefix check below never matches (same normalization as watch-sync)
  const srcDir = scope.srcDir.split(sep).join('/').replace(/\/+$/, '');
  return (file: string): boolean => {
    // the prefix check runs in absolute space (srcDir is absolute — a
    // relative path would never match); the entrypoint check in relative
    // space (entrypoints are root-relative)
    const norm = file.split(sep).join('/');
    if (!norm.startsWith(`${srcDir}/`)) return false;
    if (norm.endsWith('.css')) return false;
    const rel = toRelative(scope.root, file);
    return !scope.routes.captured.some((route) => route.entrypoint === rel);
  };
}

/**
 * The loader's commit signal (#133): astro's dev data store lives at
 * `<root>/.astro/data-store.json` (dev always uses the dot-astro dir; the
 * chunked form lands under `.astro/data-store/`), and astro itself adds it
 * to `server.watcher` — its add/change events fire exactly when the content
 * layer wrote the store, the same instant core invalidates its own
 * data-store module. The srcDir classification fires pre-commit: the
 * loader's store write is debounced 500 ms (SAVE_DEBOUNCE_MS,
 * mutable-data-store.js on astro@7.2.7), so a chrome refetch on that
 * signal alone races the commit and loses ~always — `astroix:content-synced`
 * needs this post-commit leg to mean "synced". Internals seam: the store
 * path is not public API — if astro ever moves it, this predicate goes
 * quiet and the push degrades to the srcDir signal (a slower refresh,
 * never a break).
 */
export function createLoaderCommitClassifier(root: string): (file: string) => boolean {
  const storePrefix = `${root.split(sep).join('/').replace(/\/+$/, '')}/.astro/`;
  return (file: string): boolean => {
    const norm = file.split(sep).join('/');
    return norm === `${storePrefix}data-store.json` || norm.startsWith(`${storePrefix}data-store/`);
  };
}

/** The grace between the content signal and the push — see createContentSyncPusher. */
const RENDER_GRACE_MS = 1_000;

/**
 * The content-synced pusher (#133): every content signal (srcDir or loader
 * commit) schedules one deferred `astroix:content-synced` push,
 * leading-edge per window — a burst coalesces into the first pending push,
 * and a signal after it fired schedules the next, so sustained churn never
 * starves the chrome. The deferral is load-bearing, not cosmetic: on the
 * loader commit, core's own data-store listener (registered ahead of ours
 * on the same watcher event) broadcasts a vite `full-reload`, and the
 * canvas iframe's re-render goes through the ssr environment's shared
 * module runner at the same moment the chrome's invalidation refetch would
 * evaluate that graph through a fresh runner — those two evaluations
 * racing leave the re-render serving the pre-commit store for good
 * (verified live on astro@7.2.7: the canvas keeps the old title until the
 * next edit; a srcDir-only push, whose refetch lands well before the
 * reload, never triggers it). The grace schedules the refetch after the
 * reload render has served.
 */
export function createContentSyncPusher(server: ViteDevServer): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      pushToChrome(server, 'astroix:content-synced');
    }, RENDER_GRACE_MS);
  };
}

/**
 * The no-audience guard every astroix pusher shares (routes push, #119;
 * content-synced push, #133): with no connected client nobody holds a
 * stale cache key, and vite accumulates a send listener per early send,
 * which trips its EventEmitter warning.
 */
export function pushToChrome(
  server: ViteDevServer,
  event: 'astroix:routes-changed' | 'astroix:content-synced',
): void {
  if (server.ws.clients.size === 0) return;
  server.ws.send(event, {});
}
