import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ViteServerLike } from '../../astro-project-adapter/seam-readers';
import {
  createStylesInvalidationSource,
  isProjectRelativePath,
  type StylesInvalidation,
} from '../../astro-project-adapter/styles/convergence/invalidation-source';

/**
 * The revisioned styles invalidation source (#227): the composition
 * watcher filtered to style-truth files, every accepted event minting
 * the next monotonic revision — the freshness half of the convergence
 * protocol. The events carry project-relative posix paths only (output
 * hygiene: the watcher's absolute paths never cross the seam).
 */

const PROJECT_ROOT = '/proj/canonical-root';

function serverOver(watcher: unknown): ViteServerLike {
  return {
    environments: {
      ssr: {},
      client: {},
    },
    watcher: watcher as ViteServerLike['watcher'],
    close: async () => {},
  };
}

/** A chokidar-shaped watcher: `on`/`off` over a real emitter. */
interface WatcherWithOff {
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
}

function watcherEmitter(): { emitter: EventEmitter; watcher: WatcherWithOff } {
  const emitter = new EventEmitter();
  return {
    emitter,
    watcher: {
      on: (event: string, listener: (...args: never[]) => void) => {
        emitter.on(event, listener as (...args: unknown[]) => void);
        return emitter;
      },
      off: (event: string, listener: (...args: never[]) => void) => {
        emitter.off(event, listener as (...args: unknown[]) => void);
        return emitter;
      },
    },
  };
}

describe('createStylesInvalidationSource', () => {
  it('mints monotonic revisions for style-truth changes, project-relative', () => {
    const { emitter, watcher } = watcherEmitter();
    const source = createStylesInvalidationSource(serverOver(watcher), PROJECT_ROOT);
    const events: StylesInvalidation[] = [];
    source.subscribe((event) => events.push(event));

    emitter.emit('change', `${PROJECT_ROOT}/src/pages/index.astro`);
    emitter.emit('change', `${PROJECT_ROOT}/src/pages/home.css`);
    emitter.emit('add', `${PROJECT_ROOT}/src/components/new.astro`);
    emitter.emit('unlink', `${PROJECT_ROOT}/src/pages/gone.css`);

    expect(events).toEqual([
      { revision: 1, file: 'src/pages/index.astro' },
      { revision: 2, file: 'src/pages/home.css' },
      { revision: 3, file: 'src/components/new.astro' },
      { revision: 4, file: 'src/pages/gone.css' },
    ]);
    expect(source.revision).toBe(4);
  });

  it('ignores files outside the style-truth inputs', () => {
    const { emitter, watcher } = watcherEmitter();
    const source = createStylesInvalidationSource(serverOver(watcher), PROJECT_ROOT);
    const events: StylesInvalidation[] = [];
    source.subscribe((event) => events.push(event));

    emitter.emit('change', `${PROJECT_ROOT}/src/content.config.ts`);
    emitter.emit('change', `${PROJECT_ROOT}/src/content/blog/post.md`);
    emitter.emit('change', `${PROJECT_ROOT}/src/assets/pixel.png`);
    emitter.emit('change', `${PROJECT_ROOT}/node_modules/pkg/x.css`);
    emitter.emit('change', `${PROJECT_ROOT}/.astro/types.d.ts`);
    emitter.emit('change', '/elsewhere/src/pages/index.astro');
    emitter.emit('change', PROJECT_ROOT);
    emitter.emit('change', 42);

    expect(events).toEqual([]);
    expect(source.revision).toBe(0);
  });

  it('never discloses the project root or absolute paths in its events', () => {
    const { emitter, watcher } = watcherEmitter();
    const source = createStylesInvalidationSource(serverOver(watcher), PROJECT_ROOT);
    const events: StylesInvalidation[] = [];
    source.subscribe((event) => events.push(event));
    emitter.emit('change', `${PROJECT_ROOT}/src/pages/index.astro`);
    expect(events[0]?.file).toBe('src/pages/index.astro');
    expect(events[0]?.file.startsWith('/')).toBe(false);
    expect(JSON.stringify(events)).not.toContain(PROJECT_ROOT);
  });

  it('unbinds a subscribed listener via the returned unsubscribe', () => {
    const { emitter, watcher } = watcherEmitter();
    const source = createStylesInvalidationSource(serverOver(watcher), PROJECT_ROOT);
    const seen: StylesInvalidation[] = [];
    const unbind = source.subscribe((event) => seen.push(event));
    emitter.emit('change', `${PROJECT_ROOT}/src/pages/index.astro`);
    unbind();
    emitter.emit('change', `${PROJECT_ROOT}/src/pages/home.css`);
    expect(seen).toHaveLength(1);
  });

  it('dispose unbinds the watcher subscriptions and freezes the stream', () => {
    const { emitter, watcher } = watcherEmitter();
    const source = createStylesInvalidationSource(serverOver(watcher), PROJECT_ROOT);
    const seen: StylesInvalidation[] = [];
    source.subscribe((event) => seen.push(event));
    expect(emitter.listenerCount('change')).toBe(1);

    source.dispose();
    expect(emitter.listenerCount('change')).toBe(0);
    expect(emitter.listenerCount('add')).toBe(0);
    expect(emitter.listenerCount('unlink')).toBe(0);

    emitter.emit('change', `${PROJECT_ROOT}/src/pages/index.astro`);
    expect(seen).toEqual([]);
    expect(source.revision).toBe(0);

    // Idempotent.
    source.dispose();
  });

  it('dispose stays safe over a watcher without an unbind surface', () => {
    const onOnly = {
      on: (_event: string, _listener: (...args: never[]) => void) => ({}),
    };
    const source = createStylesInvalidationSource(serverOver(onOnly), PROJECT_ROOT);
    expect(() => source.dispose()).not.toThrow();
  });

  it('rejects an absolute relative() result — the Windows cross-drive disclosure guard', () => {
    // Review round 1 (#303): Windows `relative` across drives returns an
    // ABSOLUTE path (`relative('C:\proj', 'D:\x.css') === 'D:\x.css'`),
    // which must never mint an event (ADR-0006 §7). Posix CI cannot make
    // `relative` return absolute, so this leg injects one through the same
    // post-relativization guard the source uses; on Windows the platform's
    // own `isAbsolute` behind that guard catches the drive-letter form.
    expect(isProjectRelativePath('/etc/exploit.css')).toBe(false);
    expect(isProjectRelativePath('../climb-out.css')).toBe(false);
    expect(isProjectRelativePath('')).toBe(false);
    expect(isProjectRelativePath('src/pages/index.astro')).toBe(true);
  });
});
