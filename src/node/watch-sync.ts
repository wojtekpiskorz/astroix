import { sep } from 'node:path';
import type { ViteDevServer } from 'vite';
import { toRelative } from './rest';

/**
 * The file→chrome half of the sync (spec #13): the host watcher is the only
 * FS subscriber; css/astro changes under the project's src dir are debounced
 * per file and pushed to the chrome as `astroix:file-changed` over the Vite
 * WebSocket — the same channel Astro uses for its own events. The chrome
 * refetches content/payload on receipt; its own writes echo back as no-ops
 * (content compare client-side).
 */
export function registerFileSync(
  server: ViteDevServer,
  options: { root: string; srcDir: string },
): void {
  // astro hands srcDir as a URL that keeps a trailing slash — strip it or
  // the startsWith filter below never matches
  const srcDir = options.srcDir.split(sep).join('/').replace(/\/+$/, '');
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const push = (file: string): void => {
    const timer = pending.get(file);
    if (timer !== undefined) clearTimeout(timer);
    pending.set(
      file,
      setTimeout(() => {
        pending.delete(file);
        server.ws.send('astroix:file-changed', { file: toRelative(options.root, file) });
      }, 100),
    );
  };

  const isWatchedSource = (file: string): boolean => {
    const norm = file.split(sep).join('/');
    if (!norm.startsWith(`${srcDir}/`)) return false;
    return norm.endsWith('.css') || norm.endsWith('.astro');
  };

  // `add` matters too: IDE atomic saves (write temp + rename) can surface as
  // add instead of change depending on the editor
  server.watcher.on('change', (file) => {
    if (isWatchedSource(file)) push(file);
  });
  server.watcher.on('add', (file) => {
    if (isWatchedSource(file)) push(file);
  });
}
