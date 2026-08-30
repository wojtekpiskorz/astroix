import { sep } from 'node:path';
import type { ViteDevServer } from 'vite';
import { toRelative } from './rest';
import type { RoutesState } from './routes';

/**
 * A dir path as posix with the trailing slash stripped, so the `startsWith`
 * joins below match astro's URL-form dirs (a windows-style or suffixed path
 * would never match). watch-sync.ts carries the same idiom for its own dirs.
 */
function toPosixDir(dir: string): string {
  return dir.split(sep).join('/').replace(/\/+$/, '');
}

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
  const srcDir = toPosixDir(scope.srcDir);
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
  const storePrefix = `${toPosixDir(root)}/.astro/`;
  return (file: string): boolean => {
    const norm = file.split(sep).join('/');
    return norm === `${storePrefix}data-store.json` || norm.startsWith(`${storePrefix}data-store/`);
  };
}

/**
 * Which watcher leg a `astroix:content-synced` push carries (#155): the
 * srcDir signal fires pre-commit (the loader's store write is debounced
 * 500 ms), the loader's data-store write is the post-commit leg. The label
 * is the whole payload — the chrome sequences on it: only the loader leg's
 * refetch races the canvas's post-commit full-reload render (verified live
 * on astro@7.2.7: the re-render and a concurrent fresh-runner evaluation
 * leave the canvas serving the pre-commit store for good), so the chrome
 * holds that leg's invalidation until its canvas-load signal proves the
 * reload's render served, while the srcDir leg — whose refetch lands well
 * before the reload — invalidates immediately. The server stays dumb about
 * timing; it only says which signal fired.
 */
export type ContentSyncLeg = 'srcdir' | 'loader';

/**
 * The no-audience guard this file's pushers share (routes push, #119;
 * content-synced push, #133 — watch-sync's older `file-changed` push
 * predates it): with no connected client nobody holds a stale cache key,
 * and vite accumulates a send listener per early send, which trips its
 * EventEmitter warning.
 */
export function pushToChrome(server: ViteDevServer, event: 'astroix:routes-changed'): void;
export function pushToChrome(
  server: ViteDevServer,
  event: 'astroix:content-synced',
  leg: ContentSyncLeg,
): void;
export function pushToChrome(
  server: ViteDevServer,
  event: 'astroix:routes-changed' | 'astroix:content-synced',
  leg?: ContentSyncLeg,
): void {
  if (server.ws.clients.size === 0) return;
  server.ws.send(event, event === 'astroix:content-synced' ? { leg } : {});
}
