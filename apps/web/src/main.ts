import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { createWebControlPlane } from './control-plane.ts';

/**
 * The web host's entry (#240, G1). Boot shape (the dev-checkout seam,
 * the #230 process-lane idiom): `node --experimental-transform-types
 * --import ./apps/web/raw-node-register.mjs --env-file <env>
 * apps/web/src/main.ts` — the register supplies bundler-resolution
 * semantics and the transform flag the workspace's non-strip-only TypeScript
 * (parameter properties); the packaged runtime's rebased entry needs
 * neither (ADR-0008).
 *
 * Builds the client documents (vite —
 * the workspace's own toolchain at the workspace's own version, used
 * ONLY as this host's document bundler, never inside a managed
 * project), boot the production control-plane composition over the
 * explicitly injected isolated test registry, print the readiness line
 * the test host polls on, and terminate cleanly on SIGTERM/SIGINT —
 * the honest ordered shutdown, never a killed child.
 *
 * Environment (the whole configuration surface — no flags, no files):
 * - `ASTROIX_WEB_PORT` — the loopback port to bind (default: OS-assigned).
 * - `ASTROIX_WEB_REGISTRY_DIR` — REQUIRED: the isolated registry
 *   directory (ADR-0006 §2; web mode never acquires the production
 *   registry-writer lease).
 * - `ASTROIX_WEB_REGISTER` — optional `:`-separated project roots the
 *   control plane registers at boot (the native directory grant's
 *   stand-in — test-owned setup, never browser-supplied).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = join(HERE, '..', 'client');
const CLIENT_DIST = join(HERE, '..', 'dist-client');

async function main(): Promise<void> {
  const registryDirectory = process.env.ASTROIX_WEB_REGISTRY_DIR;
  if (registryDirectory === undefined || registryDirectory.length === 0) {
    console.error('astroix-web: ASTROIX_WEB_REGISTRY_DIR is required (the isolated test registry)');
    process.exitCode = 1;
    return;
  }
  const port = Number.parseInt(process.env.ASTROIX_WEB_PORT ?? '0', 10);
  const registerRoots = (process.env.ASTROIX_WEB_REGISTER ?? '')
    .split(':')
    .filter((root) => root.length > 0);

  await rm(CLIENT_DIST, { recursive: true, force: true });
  await mkdir(CLIENT_DIST, { recursive: true });
  await build({
    root: CLIENT_ROOT,
    base: '/__astroix/app/',
    build: {
      outDir: CLIENT_DIST,
      emptyOutDir: false,
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

  const plane = await createWebControlPlane({
    registryDirectory,
    port: Number.isFinite(port) ? port : 0,
    clientDist: CLIENT_DIST,
    registerRoots,
  });
  console.log(`astroix-web: listening on ${plane.launcherOrigin}`);

  const terminate = (signal: string): void => {
    console.log(`astroix-web: ${signal} — shutting down`);
    void plane.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => terminate('SIGTERM'));
  process.once('SIGINT', () => terminate('SIGINT'));
}

await main();
