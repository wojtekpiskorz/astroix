import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PACKAGED_CERTIFIED_PAIR,
  PACKAGED_ELECTRON_PIN,
  PACKAGED_FORGE_PIN,
  PACKAGED_NODE_PIN,
  verifyPackagedAssets,
} from '../../packages/runtime/src/internal/packaged-assets.ts';
import { verifyBundledNodeIdentity } from '../../scripts/qualification/battery.ts';

/**
 * The qualification battery's own facets (#258, L1 focused tests):
 * the bundled-Node identity law over synthetic resource trees, and —
 * through the SAME packaged-asset adapter the app boots with — the
 * symlink-substitution, extra-file, and wrong-runtime artifact
 * rejections. These legs are pure filesystem work (no codesign), so
 * they run everywhere the harness's tests do; the battery's composed
 * run against real signatures is the local exact-artifact leg.
 */

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'astroix-qualification-battery-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** The stub bundled Node: prints one fixed identity report, whatever the arguments. */
async function stubNode(resourcesRoot: string, version: string, abi = '137'): Promise<string> {
  const path = join(resourcesRoot, 'node', 'bin', 'node');
  await mkdir(join(resourcesRoot, 'node', 'bin'), { recursive: true });
  await writeFile(
    path,
    `#!/bin/sh\nprintf '%s' '{"version":"${version}","abi":${JSON.stringify(abi)}}'\n`,
  );
  await chmod(path, 0o755);
  return path;
}

/** Writes a synthetic build manifest declaring the given Node pin. */
async function stubManifest(resourcesRoot: string, node: string): Promise<void> {
  await mkdir(join(resourcesRoot, 'astroix-runtime'), { recursive: true });
  await writeFile(
    join(resourcesRoot, 'astroix-runtime', 'build-manifest.json'),
    `${JSON.stringify({ schema: 1, node }, null, 2)}\n`,
  );
}

/** The minimal ratified layout: node executable, entry, module-type marker, manifest. */
async function stubResources(appPath: string, nodeVersion = PACKAGED_NODE_PIN): Promise<string> {
  const resourcesRoot = join(appPath, 'Contents', 'Resources');
  await stubNode(resourcesRoot, nodeVersion);
  await mkdir(join(resourcesRoot, 'astroix-runtime', 'control-plane'), { recursive: true });
  await writeFile(
    join(resourcesRoot, 'astroix-runtime', 'control-plane', 'child.js'),
    'export {}\n',
  );
  await writeFile(join(resourcesRoot, 'astroix-runtime', 'package.json'), '{"type":"module"}\n');
  await stubManifest(resourcesRoot, nodeVersion);
  return resourcesRoot;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

/** Builds a manifest whose resource rows hash the REAL stub bytes (self-consistent, like the assembler's). */
async function writeConsistentManifest(appPath: string, nodeVersion: string): Promise<void> {
  const resourcesRoot = join(appPath, 'Contents', 'Resources');
  const rows: { path: string; sha256: string; bytes: number; executable: boolean }[] = [];
  for (const rel of [
    join('node', 'bin', 'node'),
    join('astroix-runtime', 'control-plane', 'child.js'),
    join('astroix-runtime', 'package.json'),
  ]) {
    const absolute = join(resourcesRoot, ...rel.split('/'));
    rows.push({
      path: rel.split('/').join('/'),
      sha256: await sha256(absolute),
      bytes: (await readFile(absolute)).byteLength,
      executable: rel === join('node', 'bin', 'node'),
    });
  }
  await writeFile(
    join(resourcesRoot, 'astroix-runtime', 'build-manifest.json'),
    `${JSON.stringify(
      {
        schema: 1,
        sourceCommit: '0123456789abcdef0123456789abcdef01234567',
        architecture: 'arm64',
        electron: PACKAGED_ELECTRON_PIN,
        forge: PACKAGED_FORGE_PIN,
        node: nodeVersion,
        pair: { astro: PACKAGED_CERTIFIED_PAIR.astro, vite: PACKAGED_CERTIFIED_PAIR.vite },
        resources: rows,
      },
      null,
      2,
    )}\n`,
  );
}

describe('the bundled-Node identity law (#258)', () => {
  it('passes when the executed binary, the declared pin, and the pin table agree', async () => {
    const appPath = join(scratch, 'Astroix.app');
    await stubResources(appPath);
    const outcome = await verifyBundledNodeIdentity(appPath);
    expect(outcome.ok).toBe(true);
    expect(outcome.declaredPin).toBe(PACKAGED_NODE_PIN);
    expect(outcome.executedVersion).toBe(PACKAGED_NODE_PIN);
    expect(outcome.executedAbi).toBe('137');
    expect(outcome.failure).toBeNull();
  });

  it('rejects a wrong runtime — a self-consistent manifest cannot fake the executed identity', async () => {
    // the manifest declares the true pin; the binary reports another
    // version — exactly the self-consistent substitution the executed
    // identity check exists to catch
    const appPath = join(scratch, 'Astroix.app');
    await stubResources(appPath, PACKAGED_NODE_PIN);
    const resourcesRoot = join(appPath, 'Contents', 'Resources');
    await rm(join(resourcesRoot, 'node'), { recursive: true, force: true });
    await stubNode(resourcesRoot, 'v21.7.3');
    await writeConsistentManifest(appPath, PACKAGED_NODE_PIN);
    const outcome = await verifyBundledNodeIdentity(appPath);
    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe('identity-mismatch');
    expect(outcome.executedVersion).toBe('v21.7.3');
    expect(outcome.declaredPin).toBe(PACKAGED_NODE_PIN);
  });

  it('rejects a manifest declaring a pin the table does not carry', async () => {
    const appPath = join(scratch, 'Astroix.app');
    await stubResources(appPath, 'v18.0.0');
    const outcome = await verifyBundledNodeIdentity(appPath);
    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe('identity-mismatch');
    expect(outcome.declaredPin).toBe('v18.0.0');
  });

  it('rejects a missing manifest and a non-executable bundled binary — never guesses', async () => {
    const missing = join(scratch, 'Astroix.app');
    await mkdir(missing, { recursive: true });
    expect(await verifyBundledNodeIdentity(missing)).toMatchObject({ failure: 'manifest-missing' });

    const appPath = join(scratch, 'Astroix2.app');
    await stubResources(appPath);
    await chmod(join(appPath, 'Contents', 'Resources', 'node', 'bin', 'node'), 0o644);
    const outcome = await verifyBundledNodeIdentity(appPath);
    expect(outcome.failure).toBe('node-execution-failed');
  });
});

describe('the resource facets through the packaged-asset adapter (#258)', () => {
  it('accepts a self-consistent synthetic resource tree — the valid baseline is provable', async () => {
    const appPath = join(scratch, 'Astroix.app');
    await stubResources(appPath);
    await writeConsistentManifest(appPath, PACKAGED_NODE_PIN);
    const verified = await verifyPackagedAssets({
      resourcesRoot: join(appPath, 'Contents', 'Resources'),
      architecture: 'arm64',
      electronVersion: PACKAGED_ELECTRON_PIN,
    });
    if ('code' in verified) {
      throw new Error(`the adapter rejected a self-consistent tree: ${JSON.stringify(verified)}`);
    }
    expect(verified.nodeExecutable.endsWith(join('node', 'bin', 'node'))).toBe(true);
    expect(verified.execArgv).toEqual([]);
  });

  it('rejects a symlink substitution — a resource leaf replaced by a link fails closed', async () => {
    const appPath = join(scratch, 'Astroix.app');
    await stubResources(appPath);
    await writeConsistentManifest(appPath, PACKAGED_NODE_PIN);
    const entry = join(
      appPath,
      'Contents',
      'Resources',
      'astroix-runtime',
      'control-plane',
      'child.js',
    );
    const outside = join(scratch, 'outside-payload.js');
    await writeFile(outside, 'export { evil }\n');
    await rm(entry);
    await symlink(outside, entry);
    const verified = await verifyPackagedAssets({
      resourcesRoot: join(appPath, 'Contents', 'Resources'),
      architecture: 'arm64',
      electronVersion: PACKAGED_ELECTRON_PIN,
    });
    expect(verified).toMatchObject({
      code: 'resource-symlink',
      resource: 'astroix-runtime/control-plane/child.js',
    });
  });

  it('rejects an unexpected file inside the ratified subtrees', async () => {
    const appPath = join(scratch, 'Astroix.app');
    await stubResources(appPath);
    await writeConsistentManifest(appPath, PACKAGED_NODE_PIN);
    await writeFile(
      join(appPath, 'Contents', 'Resources', 'astroix-runtime', 'dropped-in.js'),
      'export {}\n',
    );
    const verified = await verifyPackagedAssets({
      resourcesRoot: join(appPath, 'Contents', 'Resources'),
      architecture: 'arm64',
      electronVersion: PACKAGED_ELECTRON_PIN,
    });
    expect(verified).toMatchObject({ code: 'layout-unlisted' });
  });

  it('rejects a tampered resource byte (the manifest hash law)', async () => {
    const appPath = join(scratch, 'Astroix.app');
    await stubResources(appPath);
    await writeConsistentManifest(appPath, PACKAGED_NODE_PIN);
    await writeFile(
      join(appPath, 'Contents', 'Resources', 'astroix-runtime', 'control-plane', 'child.js'),
      'export {} // one appended comment changes the bytes\n',
    );
    const verified = await verifyPackagedAssets({
      resourcesRoot: join(appPath, 'Contents', 'Resources'),
      architecture: 'arm64',
      electronVersion: PACKAGED_ELECTRON_PIN,
    });
    expect(verified).toMatchObject({ code: 'resource-tampered' });
  });
});
