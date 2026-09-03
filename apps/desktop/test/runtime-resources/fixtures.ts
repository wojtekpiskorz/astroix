import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILD_MANIFEST_RESOURCE_PATH,
  type BuildManifest,
  buildManifest,
  CONTROL_PLANE_ENTRY_RESOURCE_PATH,
  MODULE_TYPE_MARKER_RESOURCE_PATH,
  NODE_EXECUTABLE_RESOURCE_PATH,
  PACKAGED_ELECTRON_PIN,
  serializeManifest,
  verifyPackagedAssets,
} from '@wojciechpiskorz/astroix-runtime/internal/packaged-assets';
import { afterEach } from 'vitest';
import { sha256File } from '../../src/forge/inventory.ts';
import type { RuntimeAssetHostFacts } from '../../src/runtime-assets/resolve-runtime-assets.ts';

/**
 * The focused runtime-resource fixtures (#244, H2): deterministic temp
 * resources roots shaped exactly like the packaged layout — fake
 * executables with REAL recorded SHA-256s — so the adapter, the
 * resolver, and the no-leak legs run against honest filesystem truth
 * without ever downloading or spawning the real 100 MB Node binary
 * (that spawn lives in the self-skipping packaged-spawn lane, the
 * certify:adapter precedent).
 */

/** A source commit shape the manifest accepts (the fixture's stand-in for `git rev-parse HEAD`). */
export const FIXTURE_SOURCE_COMMIT = 'abababababababababababababababababababab';

/** The fixture's host identity — an arm64 host running the pinned Electron. */
export const FIXTURE_ARCHITECTURE = 'arm64';

const scratchRoots: string[] = [];

/** One fresh temp root, tracked for cleanup after the test. */
export async function newScratchRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  scratchRoots.push(root);
  return root;
}

afterEach(async () => {
  // permissions tampered for the inaccessible legs must come back before
  // removal, or the recursive delete itself fails on macOS
  for (const root of scratchRoots.splice(0)) {
    await chmod(join(root, 'node', 'bin'), 0o755).catch(() => {});
    await chmod(join(root, 'astroix-runtime', 'evil'), 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Writes one complete, VERIFYING packaged fixture: the fake stock Node
 * executable (exec bit on), the rebased control-plane entry, the
 * module-type marker, and the build manifest the adapter accepts. Every
 * broken-layout test starts from this and breaks exactly one thing.
 */
export async function writePackagedFixture(root: string): Promise<BuildManifest> {
  await mkdir(join(root, 'node', 'bin'), { recursive: true });
  await mkdir(join(root, 'astroix-runtime', 'control-plane'), { recursive: true });

  const nodeBinary = join(root, NODE_EXECUTABLE_RESOURCE_PATH);
  await writeFile(nodeBinary, 'astroix-stock-node-fake-binary\n');
  await chmod(nodeBinary, 0o755);

  await writeFile(
    join(root, CONTROL_PLANE_ENTRY_RESOURCE_PATH),
    'export const booted = true; // the rebased control-plane child\n',
  );
  await writeFile(join(root, MODULE_TYPE_MARKER_RESOURCE_PATH), '{"type":"module"}\n');

  const manifest = buildManifest({
    sourceCommit: FIXTURE_SOURCE_COMMIT,
    architecture: FIXTURE_ARCHITECTURE,
    resources: [
      await manifestFacts(root, NODE_EXECUTABLE_RESOURCE_PATH, true),
      await manifestFacts(root, CONTROL_PLANE_ENTRY_RESOURCE_PATH, false),
      await manifestFacts(root, MODULE_TYPE_MARKER_RESOURCE_PATH, false),
    ],
  });
  await writeManifest(root, manifest);
  return manifest;
}

/** (Re)writes the manifest from a built object. */
export async function writeManifest(root: string, manifest: BuildManifest): Promise<void> {
  await writeFile(join(root, BUILD_MANIFEST_RESOURCE_PATH), serializeManifest(manifest));
}

/** The manifest's own JSON, mutated — for legs that must record a wrong pin. */
export async function rewriteManifest(
  root: string,
  mutate: (parsed: Record<string, unknown>) => void,
): Promise<void> {
  const bytes = await readFile(join(root, BUILD_MANIFEST_RESOURCE_PATH), 'utf8');
  const parsed = JSON.parse(bytes) as Record<string, unknown>;
  mutate(parsed);
  await writeFile(join(root, BUILD_MANIFEST_RESOURCE_PATH), `${JSON.stringify(parsed, null, 2)}\n`);
}

/** Verifies a fixture root with the fixture host's identity. */
export function verifyFixture(root: string) {
  return verifyPackagedAssets({
    resourcesRoot: root,
    architecture: FIXTURE_ARCHITECTURE,
    electronVersion: PACKAGED_ELECTRON_PIN,
  });
}

/** Packaged-mode host facts for the resolver, with the fixture host's identity. */
export function packagedHostFacts(resourcesPath: string): RuntimeAssetHostFacts {
  return {
    isPackaged: true,
    resourcesPath,
    electronVersion: PACKAGED_ELECTRON_PIN,
    architecture: FIXTURE_ARCHITECTURE,
    env: {},
  };
}

/** Replaces one path with a symlink pointing outside the root — the symlink-policy attack shape. */
export async function replaceWithOutsideSymlink(
  root: string,
  resourcePath: string,
  target: string,
): Promise<void> {
  const absolute = join(root, resourcePath);
  await rm(absolute);
  await symlink(target, absolute);
}

async function manifestFacts(root: string, resourcePath: string, executable: boolean) {
  const absolute = join(root, resourcePath);
  const info = await stat(absolute);
  return {
    path: resourcePath,
    sha256: await sha256File(absolute),
    bytes: info.size,
    executable,
  };
}
