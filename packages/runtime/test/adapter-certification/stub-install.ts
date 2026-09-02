import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The resolution-layer stub (#225): a fake project installation — a
 * package.json plus node_modules manifests for exactly `astro` and `vite`
 * — used by the pair-gate units and the certification's drift negatives.
 * Stubs live at the RESOLUTION layer only (manifests, versions); the
 * Astro/Vite behavior layer is never faked — that is the certification
 * suite's job over a real install. Roots are realpath'd like real managed
 * roots, tracked for cleanup by the caller.
 */

/** Stages a stub installation and returns its realpath'd root. */
export async function stageStubInstall(pair: { astro: string; vite: string }): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astroix-adapter-stub-')));
  await writeFile(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
  for (const [name, version] of [
    ['astro', pair.astro],
    ['vite', pair.vite],
  ] as const) {
    const packageRoot = join(root, 'node_modules', name);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({ name, version })}\n`);
  }
  return root;
}

/** The shared cleanup promise for stub roots staged by a test file. */
export async function removeStubInstalls(roots: readonly string[]): Promise<void> {
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
}
