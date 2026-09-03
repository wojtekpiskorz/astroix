import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTROL_PLANE_ENTRY_RESOURCE_PATH,
  NODE_EXECUTABLE_RESOURCE_PATH,
  PACKAGED_ELECTRON_PIN,
} from '@wojciechpiskorz/astroix-runtime/internal/packaged-assets';
import { describe, expect, it } from 'vitest';
import {
  DEV_NODE_EXECUTABLE_ENV,
  devCheckoutRoot,
  type RuntimeAssetHostFacts,
  type RuntimeAssets,
  resolveRuntimeAssets,
} from '../../src/runtime-assets/resolve-runtime-assets.ts';
import { FIXTURE_ARCHITECTURE, newScratchRoot, writePackagedFixture } from './fixtures.ts';

/**
 * The desktop host's runtime-asset resolution (#244, H2): the one seam
 * that decides where the control-plane child's spawn ingredients come
 * from — packaged immutable resources (verified, no fallback) or the
 * controlled dev-checkout artifacts (H1's explicit-executable law) — and
 * nothing else. The no-fallback law is structural: packaged mode never
 * consults the dev environment, dev mode never consults the resources
 * root, and neither ever searches.
 */

/** The desktop package root, computed from THIS test file's own checkout location. */
const DESKTOP_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

describe('the desktop runtime-asset resolver (#244)', () => {
  // ——— the controlled dev-checkout anchoring ———

  describe('devCheckoutRoot', () => {
    it('anchors the bundled main layout: dist-main sits one level below the desktop package root', async () => {
      const scratch = await newScratchRoot('astroix-root-bundled-');
      const distMain = join(scratch, 'dist-main');
      await mkdir(distMain);
      await writeFile(join(scratch, 'raw-node-register.mjs'), '');

      expect(devCheckoutRoot(distMain)).toBe(scratch);
    });

    it('anchors the unbundled module layout: src/runtime-assets sits two levels below the root', async () => {
      const scratch = await newScratchRoot('astroix-root-unbundled-');
      const nested = join(scratch, 'src', 'runtime-assets');
      await mkdir(nested, { recursive: true });
      await writeFile(join(scratch, 'raw-node-register.mjs'), '');

      expect(devCheckoutRoot(nested)).toBe(scratch);
    });

    it('refuses anything deeper — locating the checkout is a named layout, never a search', async () => {
      const scratch = await newScratchRoot('astroix-root-none-');
      const deep = join(scratch, 'a', 'b', 'c');
      await mkdir(deep, { recursive: true });
      await writeFile(join(scratch, 'raw-node-register.mjs'), '');

      expect(devCheckoutRoot(deep)).toBeNull();
      expect(devCheckoutRoot(scratch)).toBeNull(); // the marker beside, not above
    });
  });

  // ——— dev mode: H1's explicit-executable law, unchanged ———

  describe('dev mode', () => {
    it('resolves the declared executable, the checkout entry, the dev loaders, and the package cwd', async () => {
      const declared = '/opt/homebrew/opt/node@24/bin/node';
      const assets = (await resolveRuntimeAssets(
        devFacts({ [DEV_NODE_EXECUTABLE_ENV]: declared }),
      )) as RuntimeAssets;

      expect(assets.mode).toBe('dev');
      expect(assets.nodeExecutable).toBe(resolve(declared));
      expect(assets.controlPlaneEntry).toBe(
        join(DESKTOP_ROOT, 'src', 'main', 'control-plane-child.ts'),
      );
      expect(assets.execArgv).toEqual([
        '--experimental-transform-types',
        '--import',
        join(DESKTOP_ROOT, 'raw-node-register.mjs'),
      ]);
      expect(assets.childCwd).toBe(DESKTOP_ROOT);
      // the unbundled layout truth: the referenced checkout artifacts exist
      expect(existsSync(assets.controlPlaneEntry)).toBe(true);
      const loader = assets.execArgv[2];
      expect(typeof loader === 'string' && existsSync(loader)).toBe(true);
    });

    it('resolves a relative declaration against the cwd — one absolute executable, always', async () => {
      const assets = (await resolveRuntimeAssets(
        devFacts({ [DEV_NODE_EXECUTABLE_ENV]: 'some/node' }),
      )) as RuntimeAssets;
      expect(assets.nodeExecutable).toBe(resolve('some/node'));
      expect(assets.nodeExecutable.startsWith('/')).toBe(true);
    });

    it('refuses a missing or empty declaration — never a PATH search, system Node, or Electron-as-Node', async () => {
      expect(await resolveRuntimeAssets(devFacts({}))).toEqual({
        code: 'dev-node-executable-required',
      });
      expect(await resolveRuntimeAssets(devFacts({ [DEV_NODE_EXECUTABLE_ENV]: '' }))).toEqual({
        code: 'dev-node-executable-required',
      });
    });

    it('never consults the resources root — a perfect packaged layout beside a dev boot stays dev', async () => {
      const root = await newScratchRoot('astroix-resolver-dev-');
      await writePackagedFixture(root);

      const assets = (await resolveRuntimeAssets({
        ...devFacts({ [DEV_NODE_EXECUTABLE_ENV]: '/opt/homebrew/opt/node@24/bin/node' }),
        resourcesPath: root,
      })) as RuntimeAssets;
      expect(assets.mode).toBe('dev');
      expect(assets.nodeExecutable).toBe('/opt/homebrew/opt/node@24/bin/node');
      expect(assets.controlPlaneEntry).toBe(
        join(DESKTOP_ROOT, 'src', 'main', 'control-plane-child.ts'),
      );
    });
  });

  // ——— packaged mode: verified immutable resources, no fallback ———

  describe('packaged mode', () => {
    it('resolves the verified assets as absolute spawn ingredients with no execArgv', async () => {
      const root = await newScratchRoot('astroix-resolver-packaged-');
      await writePackagedFixture(root);

      const assets = (await resolveRuntimeAssets(
        packagedFacts({ resourcesPath: root }),
      )) as RuntimeAssets;
      expect(assets).toEqual({
        mode: 'packaged',
        nodeExecutable: join(root, NODE_EXECUTABLE_RESOURCE_PATH),
        controlPlaneEntry: join(root, CONTROL_PLANE_ENTRY_RESOURCE_PATH),
        execArgv: [],
        childCwd: join(root, 'astroix-runtime', 'control-plane'),
      });
      expect(assets.nodeExecutable.startsWith('/')).toBe(true);
    });

    it("propagates the adapter's sanitized rejection when verification fails", async () => {
      const root = await newScratchRoot('astroix-resolver-broken-');
      await writePackagedFixture(root);
      await rm(join(root, NODE_EXECUTABLE_RESOURCE_PATH));

      expect(await resolveRuntimeAssets(packagedFacts({ resourcesPath: root }))).toEqual({
        code: 'packaged-resources-rejected',
        failure: { code: 'resource-missing', resource: NODE_EXECUTABLE_RESOURCE_PATH },
      });
    });

    it('rejects wrong-architecture resources for this host (the host facts flow through)', async () => {
      const root = await newScratchRoot('astroix-resolver-arch-');
      await writePackagedFixture(root);

      expect(
        await resolveRuntimeAssets(packagedFacts({ resourcesPath: root, architecture: 'x64' })),
      ).toEqual({
        code: 'packaged-resources-rejected',
        failure: {
          code: 'pin-mismatch',
          detail: { field: 'architecture', declared: 'arm64', expected: 'x64' },
        },
      });
    });

    it('NEVER falls back to the dev executable — a declared dev Node cannot save a broken packaged layout', async () => {
      const root = await newScratchRoot('astroix-resolver-nofallback-');
      await writePackagedFixture(root);
      await rm(join(root, 'astroix-runtime', 'build-manifest.json'));

      expect(
        await resolveRuntimeAssets({
          isPackaged: true,
          resourcesPath: root,
          electronVersion: PACKAGED_ELECTRON_PIN,
          architecture: FIXTURE_ARCHITECTURE,
          env: { [DEV_NODE_EXECUTABLE_ENV]: '/opt/homebrew/opt/node@24/bin/node' },
        }),
      ).toEqual({
        code: 'packaged-resources-rejected',
        failure: { code: 'manifest-missing', resource: 'astroix-runtime/build-manifest.json' },
      });
    });
  });
});

/** Dev-mode host facts (not packaged, an unreachable resources root, any env overrides supplied). */
function devFacts(env: Record<string, string | undefined>): RuntimeAssetHostFacts {
  return {
    isPackaged: false,
    resourcesPath: '/dev/null/unreachable-in-dev',
    electronVersion: PACKAGED_ELECTRON_PIN,
    architecture: FIXTURE_ARCHITECTURE,
    env,
  };
}

/** Packaged-mode host facts with the fixture identity (any overrides supplied). */
function packagedFacts(overrides: Partial<RuntimeAssetHostFacts>): RuntimeAssetHostFacts {
  return {
    isPackaged: true,
    resourcesPath: '/dev/null/unreachable-until-overridden',
    electronVersion: PACKAGED_ELECTRON_PIN,
    architecture: FIXTURE_ARCHITECTURE,
    env: {},
    ...overrides,
  };
}
