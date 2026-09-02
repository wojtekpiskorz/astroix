import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterError } from '../../astro-project-adapter/adapter-error';
import {
  canonicalProjectRoot,
  resolveInstalledPair,
} from '../../astro-project-adapter/installed-pair';
import { removeStubInstalls, stageStubInstall } from './stub-install';

/**
 * Installed-pair resolution (#225): Astro and Vite resolve from the
 * managed project's OWN installation (never Astroix's), the root is
 * canonicalized before resolution, and resolution failures fail closed
 * with sanitized diagnostics. Stubs live at the resolution layer only —
 * fake manifests in temp installs; the Astro/Vite behavior layer is
 * never faked (the certification suite covers it over a real install).
 */

const scratchDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'astroix-installed-pair-')));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await removeStubInstalls(scratchDirs.splice(0));
});

/** Asserts a promise rejects with an AdapterError of the given code, details, and message shape. */
async function expectAdapterError(
  promise: Promise<unknown>,
  code: string,
  details: unknown,
  message: RegExp,
): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error('expected the adapter to reject, got a resolution');
    },
    (rejection: unknown) => rejection,
  );
  expect(error).toBeInstanceOf(AdapterError);
  const adapterError = error as AdapterError;
  expect(adapterError.code).toBe(code);
  expect(adapterError.details).toEqual(details);
  expect(adapterError.message).toMatch(message);
}

/** A stub installation: package.json + node_modules manifests, no behavior. */
async function stubProject(versions: { astro: string; vite: string }): Promise<string> {
  const root = await stageStubInstall(versions);
  scratchDirs.push(root);
  return root;
}

describe('canonicalProjectRoot', () => {
  it('resolves the realpath of a symlinked root (the darwin /var case)', async () => {
    const real = await makeTempDir();
    const link = join(await makeTempDir(), 'link');
    await symlink(real, link);
    expect(await canonicalProjectRoot(link)).toBe(real);
  });
});

describe('resolveInstalledPair', () => {
  it('resolves both versions from the project installation', async () => {
    const root = await stubProject({ astro: '7.2.10', vite: '8.2.2' });
    expect(await resolveInstalledPair(root)).toEqual({ astro: '7.2.10', vite: '8.2.2' });
  });

  it('resolves through a symlinked project root (npm hoists vite beside astro)', async () => {
    // npm flattens the tree: vite lands in the project's own node_modules
    // even when only astro depends on it — the layout the resolution
    // contract names ("from the managed project's own installation").
    const root = await stubProject({ astro: '7.2.10', vite: '8.2.2' });
    const linked = join(await makeTempDir(), 'linked-root');
    await symlink(root, linked);
    expect(await resolveInstalledPair(linked)).toEqual({ astro: '7.2.10', vite: '8.2.2' });
  });

  it('fails closed when astro is not installed (unresolved, sanitized)', async () => {
    const root = await makeTempDir();
    await writeFile(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
    const viteRoot = join(root, 'node_modules', 'vite');
    await mkdir(viteRoot, { recursive: true });
    await writeFile(
      join(viteRoot, 'package.json'),
      `${JSON.stringify({ name: 'vite', version: '8.2.2' })}\n`,
    );
    await expectAdapterError(
      resolveInstalledPair(root),
      'dependency-unresolved',
      { dependency: 'astro', reason: 'not-resolvable' },
      /the managed project dependency astro does not resolve from the managed project installation/,
    );
  });

  it('fails closed on a versionless manifest', async () => {
    const root = await makeTempDir();
    await writeFile(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
    for (const name of ['astro', 'vite']) {
      const packageRoot = join(root, 'node_modules', name);
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        join(packageRoot, 'package.json'),
        `${JSON.stringify(name === 'vite' ? { name, version: '8.2.2' } : { name })}\n`,
      );
    }
    await expectAdapterError(
      resolveInstalledPair(root),
      'dependency-unresolved',
      { dependency: 'astro', reason: 'versionless-manifest' },
      /the managed project dependency astro has a manifest with no string version/,
    );
  });

  it('fails closed on an unparseable manifest', async () => {
    // Node consults the manifest during resolution, so a broken manifest
    // fails at the resolve step — the reason is resolution-layer detail;
    // the contract is: dependency-unresolved, dependency named, sanitized.
    const root = await stubProject({ astro: '7.2.10', vite: '8.2.2' });
    await writeFile(join(root, 'node_modules', 'vite', 'package.json'), '{not json');
    const rejection = await resolveInstalledPair(root).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AdapterError);
    const error = rejection as AdapterError;
    expect(error.code).toBe('dependency-unresolved');
    expect(error.details).toMatchObject({ dependency: 'vite' });
    expect(error.message).not.toContain(root);
  });

  it('keeps every rejection message disclosure-clean (no root paths)', async () => {
    const root = await makeTempDir();
    await writeFile(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
    const rejection = await resolveInstalledPair(root).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AdapterError);
    expect((rejection as AdapterError).message).not.toContain(root);
    expect((rejection as AdapterError).message).not.toMatch(/\/[a-z][^/]*\//i);
  });
});
