import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createKernelLeaseModule,
  currentRuntimePin,
  KernelLeaseError,
  QUALIFIED_RUNTIME_PIN,
} from '../../kernel-lease/kernel-lease.ts';

/**
 * The kernel-lease acquisition contract (#222 focused tests) over real
 * temporary directories and real `node:sqlite` — never mocked: the fixed
 * files and their modes, the runtime-pin gates, the journal-mode drift
 * gate, real in-process contention from a planted holder connection, and
 * the storage-unsupported rejections. A successful hold is never
 * released in-process (process exit is the release), so every test
 * composes a fresh module over a fresh directory.
 */

const scratchDirs: string[] = [];

async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'astroix-lease-'));
  scratchDirs.push(dir);
  return dir;
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

function leaseError(error: unknown): KernelLeaseError {
  expect(error).toBeInstanceOf(KernelLeaseError);
  return error as KernelLeaseError;
}

/** A planted raw holder connection holding BEGIN IMMEDIATE on the fixed lease file — the kernel's real busy source. */
function plantHolder(privateStateDirectory: string, file: string): DatabaseSync {
  const database = new DatabaseSync(join(privateStateDirectory, file), { timeout: 0 });
  database.exec('BEGIN IMMEDIATE');
  return database;
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('createKernelLeaseModule', () => {
  it('rejects a missing private state directory', () => {
    expect(() => createKernelLeaseModule({ privateStateDirectory: '' })).toThrow(TypeError);
  });

  it('fails closed on a wrong Node pin before touching any file', () => {
    const pin = { ...currentRuntimePin(), nodeVersion: 'v0.0.0-astroix-wrong' };
    const error = leaseError(
      capture(() =>
        createKernelLeaseModule({
          privateStateDirectory: '/tmp/astroix-never',
          qualifiedRuntime: pin,
        }),
      ),
    );
    expect(error.code).toBe('ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED');
  });

  it('rejects the production pin on any other runtime — the default is the strict gate', () => {
    if (process.version === QUALIFIED_RUNTIME_PIN.nodeVersion) return; // on the exact pin host there is no mismatch to prove
    expect(() => createKernelLeaseModule({ privateStateDirectory: '/tmp/astroix-never' })).toThrow(
      KernelLeaseError,
    );
  });
});

describe('holdRegistryWriter', () => {
  it('creates the fixed private file 0600 in an enforced 0700 directory', async () => {
    const dir = await makeStateDir();
    createKernelLeaseModule({
      privateStateDirectory: dir,
      qualifiedRuntime: currentRuntimePin(),
    }).holdRegistryWriter();
    expect(await modeOf(dir)).toBe(0o700);
    expect(await modeOf(join(dir, 'registry-writer.sqlite'))).toBe(0o600);
    // The other fixed file stays untouched by a registry hold — each authority owns its file only.
    await expect(access(join(dir, 'edit-writer.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('tightens a pre-existing too-loose directory and lease file', async () => {
    const dir = await makeStateDir();
    const stateDir = join(dir, 'state');
    await mkdir(stateDir, { recursive: true, mode: 0o777 });
    await chmod(stateDir, 0o755);
    const leasePath = join(stateDir, 'registry-writer.sqlite');
    await writeFile(leasePath, '');
    await chmod(leasePath, 0o644);
    createKernelLeaseModule({
      privateStateDirectory: stateDir,
      qualifiedRuntime: currentRuntimePin(),
    }).holdRegistryWriter();
    expect(await modeOf(stateDir)).toBe(0o700);
    expect(await modeOf(leasePath)).toBe(0o600);
  });

  it('holds the transaction until process exit — a raw same-process connection meets the real busy shape', async () => {
    const dir = await makeStateDir();
    createKernelLeaseModule({
      privateStateDirectory: dir,
      qualifiedRuntime: currentRuntimePin(),
    }).holdRegistryWriter();
    const contender = new DatabaseSync(join(dir, 'registry-writer.sqlite'), { timeout: 0 });
    let busy: Error | undefined;
    try {
      contender.exec('BEGIN IMMEDIATE');
    } catch (error) {
      busy = error as Error;
    }
    contender.close();
    // The live kernel-produced shape — exactly the qualified classification input.
    expect(busy).toMatchObject({
      code: 'ERR_SQLITE_ERROR',
      errcode: 5,
      errstr: 'database is locked',
    });
  });

  it('rejects a second hold on the same module — one process, one lifetime authority', async () => {
    const dir = await makeStateDir();
    const leases = createKernelLeaseModule({
      privateStateDirectory: dir,
      qualifiedRuntime: currentRuntimePin(),
    });
    leases.holdRegistryWriter();
    expect(leaseError(capture(() => leases.holdEditWriter())).code).toBe(
      'ASTROIX_KERNEL_LEASE_ALREADY_HELD',
    );
    expect(leaseError(capture(() => leases.holdRegistryWriter())).code).toBe(
      'ASTROIX_KERNEL_LEASE_ALREADY_HELD',
    );
  });
});

describe('holdEditWriter', () => {
  it('uses the separate fixed file — both leases exist as distinct kernel locks', async () => {
    const dir = await makeStateDir();
    createKernelLeaseModule({
      privateStateDirectory: dir,
      qualifiedRuntime: currentRuntimePin(),
    }).holdEditWriter();
    expect(await modeOf(join(dir, 'edit-writer.sqlite'))).toBe(0o600);
    const contender = new DatabaseSync(join(dir, 'edit-writer.sqlite'), { timeout: 0 });
    expect(() => contender.exec('BEGIN IMMEDIATE')).toThrowError(
      expect.objectContaining({ code: 'ERR_SQLITE_ERROR' }),
    );
    contender.close();
  });
});

describe('contention (real busy shape)', () => {
  it('maps the kernel-produced busy shape to UNAVAILABLE — and a successor acquires after release', async () => {
    const dir = await makeStateDir();
    const planted = plantHolder(dir, 'registry-writer.sqlite');
    const leases = createKernelLeaseModule({
      privateStateDirectory: dir,
      qualifiedRuntime: currentRuntimePin(),
    });
    expect(leaseError(capture(() => leases.holdRegistryWriter())).code).toBe(
      'ASTROIX_KERNEL_LEASE_UNAVAILABLE',
    );
    // Same-boot release: the planted holder rolls back and closes, the successor acquires without cleanup.
    planted.exec('ROLLBACK');
    planted.close();
    leases.holdRegistryWriter();
  });

  it('is exclusive per name only — a registry-writer holder does not fence the edit-writer file', async () => {
    const dir = await makeStateDir();
    const planted = plantHolder(dir, 'registry-writer.sqlite');
    try {
      const leases = createKernelLeaseModule({
        privateStateDirectory: dir,
        qualifiedRuntime: currentRuntimePin(),
      });
      leases.holdEditWriter();
    } finally {
      planted.exec('ROLLBACK');
      planted.close();
    }
  });
});

describe('fail-closed drift gates', () => {
  it('fails unqualified on a drifted embedded SQLite source id', async () => {
    const dir = await makeStateDir();
    const pin = { ...currentRuntimePin(), sqliteSourceId: 'drifted-source-id' };
    const error = leaseError(
      capture(() =>
        createKernelLeaseModule({
          privateStateDirectory: dir,
          qualifiedRuntime: pin,
        }).holdRegistryWriter(),
      ),
    );
    expect(error.code).toBe('ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED');
  });

  it('fails unqualified when the fixed file carries a persisted foreign journal mode', async () => {
    const dir = await makeStateDir();
    const tampered = new DatabaseSync(join(dir, 'registry-writer.sqlite'));
    tampered.exec('PRAGMA journal_mode = WAL');
    tampered.close();
    const error = leaseError(
      capture(() =>
        createKernelLeaseModule({
          privateStateDirectory: dir,
          qualifiedRuntime: currentRuntimePin(),
        }).holdRegistryWriter(),
      ),
    );
    expect(error.code).toBe('ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED');
  });

  it('fails storage-unsupported when the fixed file has another hard link', async () => {
    const dir = await makeStateDir();
    const leasePath = join(dir, 'registry-writer.sqlite');
    await writeFile(leasePath, '', { mode: 0o600 });
    await link(leasePath, join(dir, 'hardlink.sqlite'));
    const error = leaseError(
      capture(() =>
        createKernelLeaseModule({
          privateStateDirectory: dir,
          qualifiedRuntime: currentRuntimePin(),
        }).holdRegistryWriter(),
      ),
    );
    expect(error.code).toBe('ASTROIX_KERNEL_LEASE_STORAGE_UNSUPPORTED');
  });

  it('fails closed when the fixed file is a symlink', async () => {
    const dir = await makeStateDir();
    await writeFile(join(dir, 'target.sqlite'), '', { mode: 0o600 });
    await symlink('target.sqlite', join(dir, 'registry-writer.sqlite'));
    const error = leaseError(
      capture(() =>
        createKernelLeaseModule({
          privateStateDirectory: dir,
          qualifiedRuntime: currentRuntimePin(),
        }).holdRegistryWriter(),
      ),
    );
    expect(error.code).toBe('ASTROIX_KERNEL_LEASE_FAILED');
  });

  it('fails closed when the fixed file path is a directory', async () => {
    const dir = await makeStateDir();
    await mkdir(join(dir, 'registry-writer.sqlite'));
    const error = leaseError(
      capture(() =>
        createKernelLeaseModule({
          privateStateDirectory: dir,
          qualifiedRuntime: currentRuntimePin(),
        }).holdRegistryWriter(),
      ),
    );
    expect(error.code).toBe('ASTROIX_KERNEL_LEASE_FAILED');
  });
});

/** Runs a throwing thunk and returns the thrown value (typed by the caller's expectation). */
function capture(thunk: () => void): unknown {
  try {
    thunk();
  } catch (error) {
    return error;
  }
  throw new Error('expected the thunk to throw');
}
