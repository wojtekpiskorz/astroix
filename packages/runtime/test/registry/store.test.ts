import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LAST_KNOWN_GOOD_FILE,
  openRegistryStore,
  QUARANTINE_FILE,
  REGISTRY_FILE,
} from '../../registry/store';

/**
 * The registry store's file discipline (#221 AC): 0700 directory, 0600
 * files, same-directory temp + fsync + atomic rename + directory fsync,
 * and the quarantine rename — over real directories, never mocks.
 */

const scratchDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'astroix-store-'));
  scratchDirs.push(dir);
  return dir;
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('openRegistryStore', () => {
  it('creates the registry directory recursive and 0700', async () => {
    const base = await makeTempDir();
    const dir = join(base, 'nested', 'registry');
    await openRegistryStore(dir);
    expect(await modeOf(dir)).toBe(0o700);
  });

  it('tightens a pre-existing too-loose directory and too-loose files', async () => {
    const base = await makeTempDir();
    const dir = join(base, 'registry');
    await mkdir(dir, { recursive: true, mode: 0o777 });
    await chmod(dir, 0o755);
    await writeFile(join(dir, REGISTRY_FILE), '{}');
    await chmod(join(dir, REGISTRY_FILE), 0o644);
    await openRegistryStore(dir);
    expect(await modeOf(dir)).toBe(0o700);
    expect(await modeOf(join(dir, REGISTRY_FILE))).toBe(0o600);
  });
});

describe('writeAtomically', () => {
  it('writes exact bytes as mode 0600', async () => {
    const dir = await makeTempDir();
    const store = await openRegistryStore(dir);
    await store.writeAtomically(REGISTRY_FILE, '{"schemaVersion":1}\n');
    expect(await readFile(join(dir, REGISTRY_FILE), 'utf8')).toBe('{"schemaVersion":1}\n');
    expect(await modeOf(join(dir, REGISTRY_FILE))).toBe(0o600);
  });

  it('atomically replaces previous content — a re-read sees old or new bytes, never a mix', async () => {
    const dir = await makeTempDir();
    const store = await openRegistryStore(dir);
    await store.writeAtomically(REGISTRY_FILE, 'first-content');
    await store.writeAtomically(REGISTRY_FILE, 'second-content-longer-than-first');
    expect(await readFile(join(dir, REGISTRY_FILE), 'utf8')).toBe(
      'second-content-longer-than-first',
    );
  });

  it('replaces a leftover crash temp instead of failing on it', async () => {
    const dir = await makeTempDir();
    const store = await openRegistryStore(dir);
    // Simulate a crashed earlier write: the temp file exists with partial bytes.
    await writeFile(join(dir, `${REGISTRY_FILE}.tmp`), '{"schemaVer');
    await store.writeAtomically(REGISTRY_FILE, 'good-content');
    expect(await readFile(join(dir, REGISTRY_FILE), 'utf8')).toBe('good-content');
    // The successful write consumed its temp through the rename — no
    // residue accumulates for a later load to trip over.
    await expect(readFile(join(dir, `${REGISTRY_FILE}.tmp`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('leaves the current document untouched when the write cannot start', async () => {
    const dir = await makeTempDir();
    const store = await openRegistryStore(dir);
    await store.writeAtomically(REGISTRY_FILE, 'previous');
    await chmod(dir, 0o500); // block temp creation in the 0700-owned directory
    try {
      await expect(store.writeAtomically(REGISTRY_FILE, 'next')).rejects.toThrow();
      expect(await readFile(join(dir, REGISTRY_FILE), 'utf8')).toBe('previous');
    } finally {
      await chmod(dir, 0o700);
    }
  });
});

describe('read / exists / delete', () => {
  it('reads bytes, answers null for absence, and deletes without throwing when absent', async () => {
    const dir = await makeTempDir();
    const store = await openRegistryStore(dir);
    expect(await store.read(REGISTRY_FILE)).toBeNull();
    expect(await store.exists(REGISTRY_FILE)).toBe(false);
    await store.writeAtomically(REGISTRY_FILE, 'bytes');
    expect(await store.read(REGISTRY_FILE)).toBe('bytes');
    expect(await store.exists(REGISTRY_FILE)).toBe(true);
    await store.delete(REGISTRY_FILE);
    expect(await store.exists(REGISTRY_FILE)).toBe(false);
    await expect(store.delete(REGISTRY_FILE)).resolves.toBeUndefined();
  });
});

describe('quarantineCurrent', () => {
  it('moves the current document to the quarantine file intact', async () => {
    const dir = await makeTempDir();
    const store = await openRegistryStore(dir);
    await store.writeAtomically(REGISTRY_FILE, 'corrupt-bytes-here');
    await expect(store.quarantineCurrent()).resolves.toBe(true);
    expect(await store.exists(REGISTRY_FILE)).toBe(false);
    expect(await readFile(join(dir, QUARANTINE_FILE), 'utf8')).toBe('corrupt-bytes-here');
  });

  it('answers false when there is no current document', async () => {
    const dir = await makeTempDir();
    const store = await openRegistryStore(dir);
    await expect(store.quarantineCurrent()).resolves.toBe(false);
  });

  it('overwrites a previous quarantine when a newer document is quarantined', async () => {
    const dir = await makeTempDir();
    const store = await openRegistryStore(dir);
    await store.writeAtomically(REGISTRY_FILE, 'first-corruption');
    await store.quarantineCurrent();
    await store.writeAtomically(REGISTRY_FILE, 'second-corruption');
    await store.quarantineCurrent();
    expect(await readFile(join(dir, QUARANTINE_FILE), 'utf8')).toBe('second-corruption');
  });
});

describe('the fixed file set', () => {
  it('names the three fixed files the layer is chartered for', () => {
    expect(REGISTRY_FILE).toBe('registry.json');
    expect(LAST_KNOWN_GOOD_FILE).toBe('registry.last-known-good.json');
    expect(QUARANTINE_FILE).toBe('registry.quarantined.json');
  });
});
