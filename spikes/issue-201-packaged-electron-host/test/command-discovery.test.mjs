import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolvePackageCommand } from '../src/command-discovery.mjs';

test('resolves the requested command from the managed project when PATH is unusable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'astroix-command-discovery-'));
  const packageRoot = join(root, 'node_modules', 'example-command');
  const originalPath = process.env.PATH;

  try {
    await mkdir(join(packageRoot, 'bin'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"managed-project","private":true}\n');
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'example-command',
        version: '1.2.3',
        bin: { example: 'bin/cli.mjs', other: 'bin/other.mjs' },
      }),
    );
    await writeFile(join(packageRoot, 'bin', 'cli.mjs'), 'process.stdout.write("example")\n');
    await writeFile(join(packageRoot, 'bin', 'other.mjs'), 'process.stdout.write("other")\n');
    process.env.PATH = '/interactive-shell-path-must-not-be-used';

    const resolved = resolvePackageCommand({
      projectRoot: root,
      packageName: 'example-command',
      binName: 'example',
    });

    assert.deepEqual(resolved, {
      packageName: 'example-command',
      packageVersion: '1.2.3',
      commandPath: await realpath(join(packageRoot, 'bin', 'cli.mjs')),
      source: 'project-installation',
    });
  } finally {
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a package bin that escapes its installed package directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'astroix-command-escape-'));
  const packageRoot = join(root, 'node_modules', 'example-command');

  try {
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"managed-project","private":true}\n');
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'example-command', version: '1.2.3', bin: '../outside.mjs' }),
    );
    await writeFile(join(root, 'node_modules', 'outside.mjs'), 'process.exit(0)\n');

    assert.throws(
      () =>
        resolvePackageCommand({
          projectRoot: root,
          packageName: 'example-command',
          binName: 'example-command',
        }),
      /outside its package directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a missing project-local package without falling back to the app install', async () => {
  const root = await mkdtemp(join(tmpdir(), 'astroix-command-missing-'));

  try {
    await writeFile(join(root, 'package.json'), '{"name":"managed-project","private":true}\n');

    assert.throws(
      () =>
        resolvePackageCommand({
          projectRoot: root,
          packageName: 'astro',
          binName: 'astro',
        }),
      (error) => error?.code === 'MODULE_NOT_FOUND',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects an undeclared command name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'astroix-command-undeclared-'));
  const packageRoot = join(root, 'node_modules', 'example-command');

  try {
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"managed-project","private":true}\n');
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'example-command',
        version: '1.2.3',
        bin: { example: 'cli.mjs' },
      }),
    );
    await writeFile(join(packageRoot, 'cli.mjs'), 'process.exit(0)\n');

    assert.throws(
      () =>
        resolvePackageCommand({
          projectRoot: root,
          packageName: 'example-command',
          binName: 'missing',
        }),
      /does not declare the missing command/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
