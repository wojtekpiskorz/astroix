import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

/**
 * Builds the Electron main for the smoke lane (#243): one ES bundle at
 * `apps/desktop/dist-main/main.js` — the workspace's own toolchain (vite,
 * used as this host's bundler exactly as the web host uses it for its
 * documents), externalizing only `electron` and the node builtins; the
 * workspace runtime/protocol sources bundle in (the packaged runtime's
 * rebased entry is H2's, never this dev bundle).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, '..');
const OUT_DIR = join(DESKTOP, 'dist-main');

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

await build({
  root: DESKTOP,
  configFile: false,
  logLevel: 'silent',
  build: {
    target: 'node20',
    outDir: OUT_DIR,
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: join(DESKTOP, 'src', 'main', 'index.ts'),
      formats: ['es'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: (id) => id === 'electron' || id.startsWith('node:'),
      output: {
        entryFileNames: 'main.js',
        chunkFileNames: 'chunk-[name].js',
      },
    },
  },
});

console.log(`astroix-desktop: main bundled to ${join(OUT_DIR, 'main.js')}`);
