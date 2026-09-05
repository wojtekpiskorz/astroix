import { isAbsolute, relative, sep } from 'node:path';
import { CONTENT_CONFIG_MODULE } from '../../content/content-probes';
import type { ViteServerLike } from '../../seam-readers';

/**
 * The revisioned invalidation source (#227, ADR-0005 §"subscribe()
 * emits revisioned invalidations"; CONTEXT.md "reindex"): the composition
 * server's own watcher, filtered to the inspection-truth inputs — every
 * `.astro`/`.css` file under the project root (deliberately wider than
 * the static source walk's `src` subtree) plus the content truth (`#387`:
 * the content config module and the `src/content/` subtree the glob
 * loaders read) — with every accepted event minting the next monotonic
 * invalidation revision. The width is the safe direction: a root-level
 * stylesheet mints a revision the index cannot reflect and costs one
 * discarded raced pass — over-invalidation, never under. Content truth
 * rides the same one counter deliberately: the worker's published frames
 * carry ONE stream revision, and a content edit racing a styles pass
 * discards that pass the same blessed way.
 *
 * The source is the freshness half of the convergence protocol: watcher
 * liveness NEVER implies convergence (the B2 lesson, #217 — some
 * platforms' vite watchers never re-serve the transformed style module),
 * so an event only advances the revision and notifies; whether the world
 * actually converged is decided per pass by the parity verifier, never
 * assumed from this stream.
 *
 * Output hygiene (ADR-0006 §7): the watcher hands ABSOLUTE filesystem
 * paths, and the emitted events carry project-relative posix paths only
 * — the sanctioned carrier (the served records' `file` fields) — never
 * the project root. Debounce deliberately lives downstream (CONTEXT.md
 * reindex): this source is the raw revisioned stream the worker lane
 * (E6, #230) accumulates and publishes over the protocol.
 */

/** One observed invalidation — the revision it minted and the project-relative file. */
export interface RawInvalidation {
  /** The monotonic invalidation revision this event minted (first event = 1). */
  readonly revision: number;
  /** Project-relative posix path of the changed truth file. */
  readonly file: string;
}

/** The revisioned raw-truth seam the plane worker consumes (style AND content truth, #387). */
export interface RawInvalidationSource {
  /** The latest observed invalidation revision (0 — no invalidation observed yet). */
  readonly revision: number;
  /** Registers a listener for future invalidation events; the return value unbinds it. */
  subscribe(listener: (event: RawInvalidation) => void): () => void;
  /**
   * Idempotent teardown: unbinds the watcher subscriptions when the
   * watcher seam allows (`off`/`removeListener` — present on the
   * certified chokidar watcher, absent from the structural
   * `ViteServerLike` type) and drops every registered listener. The
   * composition server's own close owns the watcher's lifetime
   * (ADR-0005 normal stop); this dispose restores THIS source's listener
   * accounting only.
   */
  dispose(): void;
}

/** The watcher events that change truth on disk: edits, additions, removals. */
const WATCHER_EVENTS = ['change', 'add', 'unlink'] as const;

/**
 * Creates the invalidation source over a composition server's watcher.
 * The watcher is borrowed, never owned — closing it stays with the
 * runtime lifecycle that booted the composition.
 */
export function createRawInvalidationSource(
  server: ViteServerLike,
  projectRoot: string,
): RawInvalidationSource {
  const listeners = new Set<(event: RawInvalidation) => void>();
  let revision = 0;
  let disposed = false;
  const onWatcherEvent = (file: unknown): void => {
    // The certified watcher (chokidar over vite) hands string paths; a
    // non-string payload is a shape the certified pair never emits —
    // recorded as no event rather than guessed at.
    if (typeof file !== 'string') return;
    const projectFile = truthFile(projectRoot, file);
    if (projectFile === null) return;
    revision += 1;
    const event: RawInvalidation = { revision, file: projectFile };
    for (const listener of listeners) listener(event);
  };
  for (const event of WATCHER_EVENTS) {
    server.watcher.on(event, onWatcherEvent);
  }
  return {
    get revision() {
      return revision;
    },
    subscribe(listener: (event: RawInvalidation) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      unwatch(server.watcher, onWatcherEvent);
    },
  };
}

/** Unbinds one listener from every watched event when the seam allows; a watcher without an unbind surface stays bound (the composition close owns it). */
function unwatch(watcher: ViteServerLike['watcher'], listener: (file: unknown) => void): void {
  const candidate = watcher as {
    off?: (event: string, listener: (...args: never[]) => void) => unknown;
    removeListener?: (event: string, listener: (...args: never[]) => void) => unknown;
  };
  const unbind = typeof candidate.off === 'function' ? candidate.off : candidate.removeListener;
  if (typeof unbind !== 'function') return;
  for (const event of WATCHER_EVENTS) {
    unbind.call(watcher, event, listener as (...args: never[]) => void);
  }
}

/**
 * Whether a `path.relative` result stays a descendant of the root:
 * climb-outs (`..`) and the root itself are outside it, and so is an
 * ABSOLUTE result — Windows `relative` across drives returns one
 * (`relative('C:\\proj', 'D:\\x.css') === 'D:\\x.css'`), and letting it
 * through would mint an absolute path into an event, exactly the
 * ADR-0006 §7 disclosure this module exists to prevent. The predicate is
 * the platform's own `isAbsolute` (review round 1, #303): on Windows it
 * catches the drive-letter form; posix `relative` never returns absolute.
 */
export function isProjectRelativePath(relativeFile: string): boolean {
  return !isAbsolute(relativeFile) && !relativeFile.startsWith('..') && relativeFile !== '';
}

/**
 * The project-relative posix path of a watcher file, or null when the
 * file is no inspection family's truth: outside the project root, inside
 * a dot directory or `node_modules`, or none of the truth inputs —
 * style truth (`.astro`/`.css` anywhere; the static walk reads only the
 * `src` subtree on top of these skips — the extra width is the header's
 * deliberate over-invalidation) and content truth (#387: the config
 * module at its one certified location, and every file under the
 * canonical `src/content/` subtree — the glob loaders' patterns are
 * project-declared, so the whole subtree is the truth, extension-free).
 */
function truthFile(projectRoot: string, file: string): string | null {
  const projectFile = relative(projectRoot, file).split(sep).join('/');
  if (!isProjectRelativePath(projectFile)) return null;
  const segments = projectFile.split('/');
  for (const segment of segments) {
    if (segment.startsWith('.') || segment === 'node_modules') return null;
  }
  if (projectFile.endsWith('.astro') || projectFile.endsWith('.css')) return projectFile;
  if (projectFile === CONTENT_CONFIG_MODULE) return projectFile;
  if (projectFile.startsWith('src/content/')) return projectFile;
  return null;
}
