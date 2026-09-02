import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ManagedDevServerPlanError,
  managedDevServerPlan,
} from '../../project-plane/managed-astro/dev-server-plan.ts';

/**
 * The managed dev-server spawn plan (#231 focused tests): the plan is the
 * whole spawn truth — the project's OWN astro CLI resolved from its
 * installation, `dev --port --host 127.0.0.1` as explicit argv, the
 * canonical (realpath'd) root as cwd, an explicit whitelisted
 * environment, and no IPC. Failing closed is sanitized: the rejection
 * never names the root or the path it failed on.
 */

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeScratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'astroix-mds-'));
  scratchDirs.push(dir);
  return dir;
}

/** A minimal managed-project installation: package.json + node_modules/astro with a bin entry, created under the REALPATH of the staged root. */
async function stageFakeInstall(
  root: string,
  bin = 'astro.js',
): Promise<{ canonicalRoot: string; cli: string }> {
  await writeFile(join(root, 'package.json'), '{ "name": "fake-project", "private": true }\n');
  const astroDir = join(root, 'node_modules', 'astro');
  await mkdir(astroDir, { recursive: true });
  await writeFile(
    join(astroDir, 'package.json'),
    `${JSON.stringify({ name: 'astro', version: '7.2.10', bin: { astro: bin } })}\n`,
  );
  await writeFile(join(astroDir, bin), '// stand-in astro CLI entry\n');
  const canonicalRoot = await realpath(root);
  return { canonicalRoot, cli: join(canonicalRoot, 'node_modules', 'astro', bin) };
}

describe('managedDevServerPlan', () => {
  it("spawns the project's own astro CLI with explicit dev argv out of the canonical root", async () => {
    const root = await makeScratch();
    const { canonicalRoot, cli } = await stageFakeInstall(root);
    const plan = await managedDevServerPlan({ projectRoot: root, port: 4173 });
    expect(plan.executable).toBe(process.execPath);
    expect(plan.argv).toEqual([cli, 'dev', '--port', '4173', '--host', '127.0.0.1']);
    expect(plan.cwd).toBe(canonicalRoot);
    expect(plan.ipc).toBe(false);
    expect(plan.env).toEqual({
      ASTRO_TELEMETRY_DISABLED: '1',
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    });
  });

  it('canonicalizes an alias spelling of the root before anything resolves from it', async () => {
    const real = await makeScratch();
    const { canonicalRoot, cli } = await stageFakeInstall(real);
    // macOS tmpdir's /var is an alias of /private/var — one real alias, not a constructed one.
    const aliased = canonicalRoot.replace('/private/var/', '/var/');
    const plan = await managedDevServerPlan({ projectRoot: aliased, port: 4174 });
    expect(plan.cwd).toBe(canonicalRoot);
    expect(plan.argv[0]).toBe(cli);
  });

  it("accepts an explicit node executable — the packaged runtime's bundled stock Node", async () => {
    const root = await makeScratch();
    await stageFakeInstall(root);
    const plan = await managedDevServerPlan({
      projectRoot: root,
      port: 4175,
      nodeExecutable: '/opt/astroix-node/bin/node',
    });
    expect(plan.executable).toBe('/opt/astroix-node/bin/node');
  });

  it('fails closed and sanitized when the project has no astro installation', async () => {
    const root = await makeScratch();
    await writeFile(join(root, 'package.json'), '{ "name": "empty" }\n');
    const plan = managedDevServerPlan({ projectRoot: root, port: 4176 });
    await expect(plan).rejects.toBeInstanceOf(ManagedDevServerPlanError);
    const error = (await plan.catch((caught: unknown) => caught)) as ManagedDevServerPlanError;
    expect(error.code).toBe('astro-cli-unresolved');
    expect(error.message).not.toContain(root);
    expect(error.message).not.toContain(await realpath(root));
  });

  it('fails closed when the manifest has no bin entry or the entry is not a file', async () => {
    const noBin = await makeScratch();
    await writeFile(join(noBin, 'package.json'), '{}\n');
    const astroDir = join(noBin, 'node_modules', 'astro');
    await mkdir(astroDir, { recursive: true });
    await writeFile(join(astroDir, 'package.json'), '{ "name": "astro", "version": "1.0.0" }\n');
    await expect(managedDevServerPlan({ projectRoot: noBin, port: 4177 })).rejects.toThrow(
      ManagedDevServerPlanError,
    );

    const danglingBin = await makeScratch();
    await writeFile(join(danglingBin, 'package.json'), '{}\n');
    const danglingDir = join(danglingBin, 'node_modules', 'astro');
    await mkdir(danglingDir, { recursive: true });
    // The manifest names a bin entry that does not exist on disk.
    await writeFile(
      join(danglingDir, 'package.json'),
      '{ "name": "astro", "version": "1.0.0", "bin": { "astro": "missing-entry.js" } }\n',
    );
    await expect(managedDevServerPlan({ projectRoot: danglingBin, port: 4178 })).rejects.toThrow(
      ManagedDevServerPlanError,
    );
  });
});
