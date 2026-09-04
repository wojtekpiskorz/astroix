import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

/**
 * The ONE client-build config (#240, G1): the client documents (the
 * launcher and the project app) built by vite — the workspace's own
 * toolchain at the workspace's own version, used ONLY as this host's
 * document bundler, never inside a managed project. The config lived
 * inline in `src/main.ts` until the second consumer appeared (the
 * real-Electron CSS lane serves the same documents from its own
 * composition — the house rule: a shared helper is born when the
 * second consumer appears); it is owned HERE once, never re-encoded
 * beside a consumer.
 *
 * `outDir` is the caller's: the web host's boot directory or a lane's
 * scratch — the builder empties it itself (`emptyOutDir`), so a caller
 * never pre-clears.
 */

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'client');

/** Builds the client documents into `outDir` — the one base, the two entries, no config file. */
export async function buildClientDocuments(outDir: string): Promise<void> {
  await build({
    root: CLIENT_ROOT,
    base: '/__astroix/app/',
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: {
        input: {
          launcher: join(CLIENT_ROOT, 'launcher.html'),
          project: join(CLIENT_ROOT, 'project.html'),
        },
      },
    },
    logLevel: 'silent',
    configFile: false,
  });
}
