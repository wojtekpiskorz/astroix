import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';

import { verifyPackagedAssets } from '../src/packaged-assets.mjs';

async function sha256(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function makeResources({ includeNode = true, nodeVersion = 'v24.20.0' } = {}) {
  const resourcesPath = await mkdtemp(join(tmpdir(), 'astroix-packaged-assets-'));
  const runtimeDirectory = join(resourcesPath, 'astroix-runtime');
  const runtimeFile = join(runtimeDirectory, 'src', 'package-entry.mjs');
  const nodePath = join(resourcesPath, 'node', 'bin', 'node');
  await mkdir(join(runtimeDirectory, 'src'), { recursive: true, mode: 0o700 });
  const runtimeContents = 'console.log("trusted runtime");\n';
  await writeFile(runtimeFile, runtimeContents, { mode: 0o600 });
  if (includeNode) {
    await mkdir(join(resourcesPath, 'node', 'bin'), { recursive: true });
    await cp(process.execPath, nodePath);
    await chmod(nodePath, 0o755);
  }
  const binarySha256 = includeNode ? await sha256(nodePath) : '0'.repeat(64);
  await writeFile(
    join(runtimeDirectory, 'build-manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        node: {
          arch: process.arch,
          binarySha256,
          platform: process.platform,
          version: nodeVersion,
        },
        runtime: {
          files: [
            {
              path: 'src/package-entry.mjs',
              sha256: await sha256(runtimeFile),
              size: Buffer.byteLength(runtimeContents),
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { nodePath, resourcesPath, runtimeFile };
}

test('returns only the verified fixed bundled Node executable', async () => {
  const fixture = await makeResources();
  try {
    const assets = await verifyPackagedAssets({ resourcesPath: fixture.resourcesPath });

    assert.equal(assets.nodePath, await realpath(fixture.nodePath));
    assert.deepEqual(assets.runtime, {
      arch: process.arch,
      platform: process.platform,
      version: 'v24.20.0',
    });
    assert.equal('fallback' in assets, false);
    assert.equal('path' in assets.runtime, false);
  } finally {
    await rm(fixture.resourcesPath, { recursive: true, force: true });
  }
});

test('missing bundled Node fails closed without trying PATH or a system runtime', async () => {
  const fixture = await makeResources({ includeNode: false });
  try {
    await assert.rejects(
      verifyPackagedAssets({ resourcesPath: fixture.resourcesPath }),
      (error) => {
        assert.equal(error?.code, 'ASTROIX_BUNDLED_NODE_MISSING');
        assert.equal(
          error?.message,
          'Astroix cannot start because its bundled Node resource is missing. Reinstall the exact Astroix build.',
        );
        assert.equal(error?.message.includes(fixture.resourcesPath), false);
        return true;
      },
    );
  } finally {
    await rm(fixture.resourcesPath, { recursive: true, force: true });
  }
});

test('tampered bundled Node fails before spawn', async () => {
  const fixture = await makeResources();
  try {
    await writeFile(fixture.nodePath, 'tampered\n');
    await assert.rejects(
      verifyPackagedAssets({ resourcesPath: fixture.resourcesPath }),
      (error) => error?.code === 'ASTROIX_BUNDLED_NODE_INTEGRITY_FAILED',
    );
  } finally {
    await rm(fixture.resourcesPath, { recursive: true, force: true });
  }
});

test('an unqualified manifest pin fails before spawn', async () => {
  const fixture = await makeResources({ nodeVersion: 'v24.20.1' });
  try {
    await assert.rejects(
      verifyPackagedAssets({ resourcesPath: fixture.resourcesPath }),
      (error) => error?.code === 'ASTROIX_BUNDLED_NODE_UNQUALIFIED',
    );
  } finally {
    await rm(fixture.resourcesPath, { recursive: true, force: true });
  }
});

test('tampered runtime code fails before import or spawn', async () => {
  const fixture = await makeResources();
  try {
    await writeFile(fixture.runtimeFile, 'console.log("tampered runtime");\n');
    await assert.rejects(
      verifyPackagedAssets({ resourcesPath: fixture.resourcesPath }),
      (error) => error?.code === 'ASTROIX_RUNTIME_INTEGRITY_FAILED',
    );
  } finally {
    await rm(fixture.resourcesPath, { recursive: true, force: true });
  }
});

test('an unmanifested runtime file fails the fixed inventory', async () => {
  const fixture = await makeResources();
  try {
    await writeFile(join(fixture.resourcesPath, 'astroix-runtime', 'unexpected.mjs'), '');
    await assert.rejects(
      verifyPackagedAssets({ resourcesPath: fixture.resourcesPath }),
      (error) => error?.code === 'ASTROIX_RUNTIME_INTEGRITY_FAILED',
    );
  } finally {
    await rm(fixture.resourcesPath, { recursive: true, force: true });
  }
});
