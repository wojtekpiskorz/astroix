import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acquireProofRegistryLock } from '../src/registry-lock.mjs';

test('permits exactly one live proof writer and releases idempotently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astroix-registry-lock-'));
  try {
    const lock = await acquireProofRegistryLock({ directory });
    await assert.rejects(
      acquireProofRegistryLock({ directory }),
      (error) => error?.code === 'ASTROIX_REGISTRY_LOCKED',
    );
    assert.equal(await lock.release(), true);
    assert.equal(await lock.release(), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reclaims a dead writer only through the explicitly proof-only path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astroix-registry-stale-'));
  try {
    await writeFile(
      join(directory, 'proof-writer.lock'),
      `${JSON.stringify({ pid: 2_147_483_647, token: 'stale' })}\n`,
    );
    await assert.rejects(
      acquireProofRegistryLock({ directory }),
      (error) => error?.code === 'ASTROIX_REGISTRY_LOCKED',
    );
    const recovered = await acquireProofRegistryLock({
      directory,
      allowStaleRecovery: true,
    });
    assert.equal(recovered.staleRecovered, true);
    assert.equal(await recovered.release(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
