import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectKey } from '@wojciechpiskorz/astroix-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectRegistry,
  type RegistryResult,
  type SummariesResult,
} from '../../registry/project-registry';
import { LAST_KNOWN_GOOD_FILE, QUARANTINE_FILE, REGISTRY_FILE } from '../../registry/store';

/**
 * The ProjectRegistry behavior contract (#221 focused tests): alias and
 * root-symlink dedupe, remove/re-register key rotation, active-record
 * removal rejection, display-only rename, unavailable-root visibility,
 * the 0700/0600 permission gate, crash-shaped leftovers, corrupt and
 * future schema quarantine, and the explicit last-known-good restore —
 * all over a real registry directory, reopened between phases like a
 * process restart would.
 */

const scratchDirs: string[] = [];

async function makeRegistryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'astroix-registry-'));
  scratchDirs.push(dir);
  const registryDir = join(dir, 'registry');
  await mkdir(registryDir);
  return registryDir;
}

/** A project root directory outside the registry directory (as in life), realpath'd because tmpdir is itself a symlink on darwin. */
async function makeProjectRoot(name: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `astroix-root-${name}-`)));
  scratchDirs.push(dir);
  return dir;
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

function expectFailure(result: RegistryResult | SummariesResult, code: string): void {
  expect(result).toEqual({ ok: false, code, message: expect.any(String) });
}

function registeredKey(result: RegistryResult): ProjectKey {
  if (!('record' in result) || !result.ok) throw new Error(`expected a record result: ${result}`);
  return result.record.projectKey;
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('first boot and registration', () => {
  it('boots empty and healthy over a fresh directory', async () => {
    const registryDir = await makeRegistryDir();
    const registry = await createProjectRegistry(registryDir);
    expect(registry.snapshot()).toEqual({
      status: 'ok',
      records: [],
      quarantine: null,
    });
    expect(await registry.projectSummaries()).toEqual({ ok: true, summaries: [] });
  });

  it('registers a project with realpath identity, defaulted display name, and a persisted v1 document', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('site');
    const registry = await createProjectRegistry(registryDir);
    const result = await registry.execute({ kind: 'register', root });
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'registered') {
      expect(result.existed).toBe(false);
      expect(result.record.canonicalRoot).toBe(root);
      expect(result.record.displayName).toBe(root.split('/').pop());
    }
    const persisted = JSON.parse(await readFile(join(registryDir, REGISTRY_FILE), 'utf8'));
    expect(persisted).toEqual({
      schemaVersion: 1,
      records: [expect.objectContaining({ canonicalRoot: root })],
    });
    // The persisted document carries records only — no lease, PID, or owner field.
    expect(Object.keys(persisted).sort()).toEqual(['records', 'schemaVersion']);
  });

  it('maintains the last-known-good mirror at rest and enforces 0700/0600 modes', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('modes');
    const registry = await createProjectRegistry(registryDir);
    await registry.execute({ kind: 'register', root });
    expect(await modeOf(registryDir)).toBe(0o700);
    const document = await readFile(join(registryDir, REGISTRY_FILE), 'utf8');
    expect(await readFile(join(registryDir, LAST_KNOWN_GOOD_FILE), 'utf8')).toBe(document);
    expect(await modeOf(join(registryDir, REGISTRY_FILE))).toBe(0o600);
    expect(await modeOf(join(registryDir, LAST_KNOWN_GOOD_FILE))).toBe(0o600);
  });

  it('rejects a missing root and a file root with root-unavailable', async () => {
    const registryDir = await makeRegistryDir();
    const base = await makeProjectRoot('nearby');
    const file = join(base, 'plain-file');
    await writeFile(file, 'x');
    const registry = await createProjectRegistry(registryDir);
    expectFailure(
      await registry.execute({ kind: 'register', root: join(base, 'missing') }),
      'root-unavailable',
    );
    expectFailure(await registry.execute({ kind: 'register', root: file }), 'root-unavailable');
    expect(registry.snapshot().records).toHaveLength(0);
  });

  it('rejects a display name that fails the protocol disclosure guard', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('guard');
    const registry = await createProjectRegistry(registryDir);
    for (const displayName of ['', 'see /Users/owner/leak', '~/leak', 'port 4314 open']) {
      expectFailure(
        await registry.execute({ kind: 'register', root, displayName }),
        'invalid-display-name',
      );
    }
    expect(registry.snapshot().records).toHaveLength(0);
  });

  it('rejects a defaulted display name that fails the guard — a pathological basename fails closed', async () => {
    const registryDir = await makeRegistryDir();
    const base = await makeProjectRoot('pathological');
    // `port 4314 open` is a legal POSIX basename, so the root itself is
    // registrable — but its defaulted display name carries a disclosure
    // shape, and identity.ts's rule is fail-closed, never cosmetic repair.
    const root = join(base, 'port 4314 open');
    await mkdir(root);
    const registry = await createProjectRegistry(registryDir);
    expectFailure(await registry.execute({ kind: 'register', root }), 'invalid-display-name');
    expect(registry.snapshot().records).toHaveLength(0);
  });

  it('adopts a valid explicit display name on a fresh registration', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('chosen');
    const registry = await createProjectRegistry(registryDir);
    const result = await registry.execute({ kind: 'register', root, displayName: 'chosen-name' });
    expect(result.ok && result.kind === 'registered' && !result.existed).toBe(true);
    expect(registry.snapshot().records[0]?.displayName).toBe('chosen-name');
  });

  it('serializes overlapping mutations through the single document', async () => {
    const registryDir = await makeRegistryDir();
    const rootA = await makeProjectRoot('a');
    const rootB = await makeProjectRoot('b');
    const registry = await createProjectRegistry(registryDir);
    await Promise.all([
      registry.execute({ kind: 'register', root: rootA }),
      registry.execute({ kind: 'register', root: rootB }),
    ]);
    expect(registry.snapshot().records).toHaveLength(2);
  });
});

describe('alias dedupe and key rotation', () => {
  it('dedupes a root-symlink registration to the existing record without duplicating or renaming', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('real');
    const aliasParent = await makeProjectRoot('alias-holder');
    await symlink(root, join(aliasParent, 'alias-site'));

    const registry = await createProjectRegistry(registryDir);
    const first = await registry.execute({ kind: 'register', root });
    const aliased = await registry.execute({
      kind: 'register',
      root: join(aliasParent, 'alias-site'),
      displayName: 'ignored-explicit-name',
    });
    expect(aliased).toEqual({ ...first, existed: true });
    expect(registry.snapshot().records).toHaveLength(1);
  });

  it('rejects an invalid explicit displayName even on the dedupe path', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('dedupe-guard');
    const registry = await createProjectRegistry(registryDir);
    expect((await registry.execute({ kind: 'register', root })).ok).toBe(true);
    // Silently discarding the invalid name would mask a caller input error
    // the rest of the API rejects; a VALID name just stays ignored above.
    expectFailure(
      await registry.execute({ kind: 'register', root, displayName: 'see /Users/leak' }),
      'invalid-display-name',
    );
    expect(registry.snapshot().records).toHaveLength(1);
  });

  it('follows the filesystem’s case semantics: a case alias dedupes where the FS says same', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('case');
    const onDisk = join(root, 'CaseSite');
    await mkdir(onDisk);
    const registry = await createProjectRegistry(registryDir);
    await registry.execute({ kind: 'register', root: onDisk });
    const variant = join(root, 'casesite');
    const variantResolves = await realpath(variant).then(
      () => true,
      () => false,
    );
    if (variantResolves) {
      const result = await registry.execute({ kind: 'register', root: variant });
      expect(result.ok && result.kind === 'registered' && result.existed).toBe(true);
      expect(registry.snapshot().records).toHaveLength(1);
      // The stored canonical root keeps the on-disk case — no lowercasing.
      expect(registry.snapshot().records[0]?.canonicalRoot).toBe(onDisk);
    } else {
      // Case-sensitive filesystem: a different case is a different root.
      await mkdir(join(root, 'casesite-elsewhere'));
      const result = await registry.execute({
        kind: 'register',
        root: join(root, 'casesite-elsewhere'),
      });
      expect(result.ok).toBe(true);
      expect(registry.snapshot().records).toHaveLength(2);
    }
  });

  it('rotates the project key on remove and re-register of the same root', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('rotate');
    const registry = await createProjectRegistry(registryDir);
    const key1 = registeredKey(await registry.execute({ kind: 'register', root }));
    const removed = await registry.execute({ kind: 'remove', projectKey: key1 });
    expect(removed.ok).toBe(true);
    expect(registry.snapshot().records).toHaveLength(0);
    // The project root itself still exists — record removal never touches files.
    expect(await modeOf(root)).toBe(0o700);
    const key2 = registeredKey(await registry.execute({ kind: 'register', root }));
    expect(key2).not.toBe(key1);
  });

  it('remembers records across a reopen (restart)', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('persist');
    const first = await createProjectRegistry(registryDir);
    const key = registeredKey(await first.execute({ kind: 'register', root }));
    await first.close();
    const reopened = await createProjectRegistry(registryDir);
    expect(reopened.snapshot().records.map((r) => r.projectKey)).toEqual([key]);
  });
});

describe('active records, rename, and unknown keys', () => {
  it('rejects removal of the active record while allowing a display-only rename', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('active');
    const activeKey: ProjectKey[] = [];
    const registry = await createProjectRegistry(registryDir, {
      isActiveProjectKey: (key) => activeKey.includes(key),
    });
    const key = registeredKey(await registry.execute({ kind: 'register', root }));
    activeKey.push(key);
    expectFailure(await registry.execute({ kind: 'remove', projectKey: key }), 'active-record');
    expect(registry.snapshot().records).toHaveLength(1);
    const renamed = await registry.execute({
      kind: 'rename',
      projectKey: key,
      displayName: 'renamed-live',
    });
    expect(renamed.ok && renamed.kind === 'renamed').toBe(true);
    expect(registry.snapshot().records[0]?.displayName).toBe('renamed-live');
    // Identity and routing are untouched by the rename.
    expect(registry.snapshot().records[0]?.canonicalRoot).toBe(root);
    expect(registry.snapshot().records[0]?.projectKey).toBe(key);
    activeKey.pop();
    expect((await registry.execute({ kind: 'remove', projectKey: key })).ok).toBe(true);
  });

  it('rejects rename and remove for an unknown key, and invalid rename display names', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('unknown');
    const registry = await createProjectRegistry(registryDir);
    const key = registeredKey(await registry.execute({ kind: 'register', root }));
    const unknown = 'cccccccccccccccccccccccccc' as ProjectKey;
    expectFailure(
      await registry.execute({ kind: 'remove', projectKey: unknown }),
      'unknown-project-key',
    );
    expectFailure(
      await registry.execute({ kind: 'rename', projectKey: unknown, displayName: 'x' }),
      'unknown-project-key',
    );
    expectFailure(
      await registry.execute({ kind: 'rename', projectKey: key, displayName: '/Users/leak' }),
      'invalid-display-name',
    );
    expect(registry.snapshot().records[0]?.displayName).toBe(root.split('/').pop());
  });
});

describe('unavailable roots stay visible', () => {
  it('keeps a missing root in the snapshot as unavailable until explicit removal', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('vanishing');
    const registry = await createProjectRegistry(registryDir);
    const key = registeredKey(await registry.execute({ kind: 'register', root }));
    await rm(root, { recursive: true });

    expect(registry.snapshot().records).toHaveLength(1);
    const result = await registry.projectSummaries();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summaries = result.summaries;
    expect(summaries).toEqual([
      { projectKey: key, displayName: root.split('/').pop(), availability: 'unavailable' },
    ]);
    // The browser-facing summary structurally cannot carry the root.
    expect(Object.keys(summaries[0] ?? {}).sort()).toEqual([
      'availability',
      'displayName',
      'projectKey',
    ]);
    // Explicit removal of an unavailable record works; re-registering the
    // now-missing root does not.
    expect((await registry.execute({ kind: 'remove', projectKey: key })).ok).toBe(true);
    expectFailure(await registry.execute({ kind: 'register', root }), 'root-unavailable');
  });

  it('reports an available root as available', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('present');
    const registry = await createProjectRegistry(registryDir);
    await registry.execute({ kind: 'register', root });
    const available = await registry.projectSummaries();
    expect(available.ok && available.summaries[0]?.availability === 'available').toBe(true);
  });
});

describe('crash shapes at load', () => {
  it('ignores a leftover write temp beside a valid document', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('temp-left');
    const registry = await createProjectRegistry(registryDir);
    await registry.execute({ kind: 'register', root });
    await registry.close();
    await writeFile(join(registryDir, `${REGISTRY_FILE}.tmp`), '{"schemaVer');
    // unconditional loose precondition — writeFile's default mode is only
    // 0644 under umask 022; chmod makes the tightening assertion bite
    // under any umask (mirrors the sibling store.test.ts precondition)
    await chmod(join(registryDir, `${REGISTRY_FILE}.tmp`), 0o644);
    const reopened = await createProjectRegistry(registryDir);
    expect(reopened.snapshot().status).toBe('ok');
    expect(reopened.snapshot().records).toHaveLength(1);
    // the reopen's tightening loop covered the loose-temp branch too:
    // writeFile created it 0644, the boot must leave it 0600 (#209 gate)
    expect(await modeOf(join(registryDir, `${REGISTRY_FILE}.tmp`))).toBe(0o600);
  });

  it('quarantines a torn (externally damaged) current document and restores from the snapshot', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('torn');
    const registry = await createProjectRegistry(registryDir);
    const key = registeredKey(await registry.execute({ kind: 'register', root }));
    await registry.close();
    // Simulate post-rename external damage: truncated mid-document. The
    // write discipline makes this impossible for this layer's own writes;
    // the recovery path must still be defined and explicit.
    const good = await readFile(join(registryDir, REGISTRY_FILE), 'utf8');
    await writeFile(join(registryDir, REGISTRY_FILE), good.slice(0, Math.floor(good.length / 2)));

    const reopened = await createProjectRegistry(registryDir);
    expect(reopened.snapshot()).toEqual({
      status: 'quarantined',
      records: [],
      quarantine: { reason: 'corrupt', restoreAvailable: true },
    });
    expectFailure(await reopened.execute({ kind: 'register', root: root }), 'quarantined');
    const restored = await reopened.execute({ kind: 'restore' });
    expect(restored.ok && restored.kind === 'restored').toBe(true);
    expect(reopened.snapshot().status).toBe('ok');
    expect(reopened.snapshot().records.map((r) => r.projectKey)).toEqual([key]);
  });
});

describe('corrupt and future schemas quarantine', () => {
  it('quarantines a corrupt document, keeps the bytes aside, and stays quarantined across a reopen', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('corrupt');
    const registry = await createProjectRegistry(registryDir);
    await registry.execute({ kind: 'register', root });
    await registry.close();
    const garbage = '{ this is not json';
    await writeFile(join(registryDir, REGISTRY_FILE), garbage);

    const reopened = await createProjectRegistry(registryDir);
    expect(reopened.snapshot().status).toBe('quarantined');
    // The corrupt bytes survive for diagnostics; the current file is gone.
    expect(await readFile(join(registryDir, QUARANTINE_FILE), 'utf8')).toBe(garbage);
    expectFailure(await reopened.execute({ kind: 'register', root }), 'quarantined');
    expectFailure(
      await reopened.execute({
        kind: 'rename',
        projectKey: 'dddddddddddddddddddddddddd',
        displayName: 'x',
      }),
      'quarantined',
    );
    await reopened.close();

    // A crash right after quarantine must not reboot into a fresh registry.
    const reopenedAgain = await createProjectRegistry(registryDir);
    expect(reopenedAgain.snapshot().status).toBe('quarantined');
  });

  it('quarantines a future schema with its reason, and a schema-drifted record set', async () => {
    const registryDir = await makeRegistryDir();
    await writeFile(
      join(registryDir, REGISTRY_FILE),
      JSON.stringify({ schemaVersion: 2, records: [], migrations: ['v2'] }),
    );
    const registry = await createProjectRegistry(registryDir);
    expect(registry.snapshot().quarantine?.reason).toBe('unsupported-future');
    expect(registry.snapshot().records).toHaveLength(0);

    const driftedDir = await makeRegistryDir();
    await writeFile(
      join(driftedDir, REGISTRY_FILE),
      JSON.stringify({ schemaVersion: 1, records: [{ projectKey: 'short', root: '/x' }] }),
    );
    const drifted = await createProjectRegistry(driftedDir);
    expect(drifted.snapshot().quarantine?.reason).toBe('corrupt');
  });

  it('offers no restore when no valid snapshot exists', async () => {
    const registryDir = await makeRegistryDir();
    await writeFile(join(registryDir, REGISTRY_FILE), 'garbage');
    const registry = await createProjectRegistry(registryDir);
    expect(registry.snapshot().quarantine?.restoreAvailable).toBe(false);
    expectFailure(await registry.execute({ kind: 'restore' }), 'restore-unavailable');
    expect(registry.snapshot().status).toBe('quarantined');
  });

  it('offers no restore when the snapshot itself is damaged', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('bad-snapshot');
    const registry = await createProjectRegistry(registryDir);
    await registry.execute({ kind: 'register', root });
    await registry.close();
    await writeFile(join(registryDir, LAST_KNOWN_GOOD_FILE), 'not-json-at-all');
    await writeFile(join(registryDir, REGISTRY_FILE), 'also-not-json');
    const reopened = await createProjectRegistry(registryDir);
    expect(reopened.snapshot().quarantine?.restoreAvailable).toBe(false);
    expectFailure(await reopened.execute({ kind: 'restore' }), 'restore-unavailable');
  });

  it('restores exact snapshot bytes, clears the quarantine file, and resumes mutation', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('restore');
    const registry = await createProjectRegistry(registryDir);
    const key = registeredKey(await registry.execute({ kind: 'register', root }));
    await registry.close();
    const snapshotBytes = await readFile(join(registryDir, LAST_KNOWN_GOOD_FILE), 'utf8');
    await writeFile(join(registryDir, REGISTRY_FILE), '{corrupt');

    const reopened = await createProjectRegistry(registryDir);
    const restored = await reopened.execute({ kind: 'restore' });
    expect(restored.ok).toBe(true);
    expect(await readFile(join(registryDir, REGISTRY_FILE), 'utf8')).toBe(snapshotBytes);
    expect(await modeOf(join(registryDir, REGISTRY_FILE))).toBe(0o600);
    await expect(access(join(registryDir, QUARANTINE_FILE))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // The registry is usable again, and the restored key is the snapshot's key.
    expect(reopened.snapshot().records.map((r) => r.projectKey)).toEqual([key]);
    const root2 = await makeProjectRoot('after-restore');
    expect((await reopened.execute({ kind: 'register', root: root2 })).ok).toBe(true);
  });

  it('rejects restore while healthy', async () => {
    const registryDir = await makeRegistryDir();
    const registry = await createProjectRegistry(registryDir);
    expectFailure(await registry.execute({ kind: 'restore' }), 'not-quarantined');
  });

  it('clears stale quarantine residue beside a valid document without touching the document', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('residue');
    const registry = await createProjectRegistry(registryDir);
    await registry.execute({ kind: 'register', root });
    await registry.close();
    // The crash window of an interrupted restore: valid current document
    // plus a quarantine file that was never deleted.
    const documentBytes = await readFile(join(registryDir, REGISTRY_FILE), 'utf8');
    await writeFile(join(registryDir, QUARANTINE_FILE), 'stale-quarantine-bytes');
    const reopened = await createProjectRegistry(registryDir);
    expect(reopened.snapshot().status).toBe('ok');
    expect(reopened.snapshot().records).toHaveLength(1);
    expect(await readFile(join(registryDir, REGISTRY_FILE), 'utf8')).toBe(documentBytes);
  });

  it('treats a missing current document with no quarantine as a fresh registry, never auto-restoring', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('manual-delete');
    const registry = await createProjectRegistry(registryDir);
    await registry.execute({ kind: 'register', root });
    await registry.close();
    await rm(join(registryDir, REGISTRY_FILE));
    const reopened = await createProjectRegistry(registryDir);
    expect(reopened.snapshot()).toEqual({ status: 'ok', records: [], quarantine: null });
    // The snapshot file remains but is never silently promoted.
    expect(reopened.snapshot().records).toHaveLength(0);
  });
});

describe('close', () => {
  it('fences mutation and is idempotent', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('close');
    const registry = await createProjectRegistry(registryDir);
    await registry.execute({ kind: 'register', root });
    await registry.close();
    await registry.close();
    expectFailure(await registry.execute({ kind: 'register', root }), 'closed');
    // The snapshot stays readable — it is in-memory truth, not a handle.
    expect(registry.snapshot().records).toHaveLength(1);
  });

  it('fences projectSummaries — no post-close filesystem access', async () => {
    const registryDir = await makeRegistryDir();
    const root = await makeProjectRoot('close-summaries');
    const registry = await createProjectRegistry(registryDir);
    await registry.execute({ kind: 'register', root });
    await registry.close();
    expectFailure(await registry.projectSummaries(), 'closed');
  });
});
