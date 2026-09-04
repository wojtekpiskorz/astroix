import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The fixed-file store discipline (#329; ADR-0006 §2 "Persistence" and
 * §4 "atomically persist"): the ONE shared implementation of the
 * private-state file discipline under one injected directory, extracted
 * from the registry store (#221, D2) whose tombstone mirror (#239, F7)
 * was a lane-fenced verbatim copy — the next private-state consumer
 * imports this and never copies again. Every write is a same-directory
 * temporary file, file fsync, atomic rename, and a directory fsync, so
 * a crash at any point leaves either the whole previous file or the
 * whole new one, never a torn byte sequence and never a rename the
 * directory forgot while the data blocks were still in flight. Modes
 * are enforced, not assumed: the directory is 0700 and every file this
 * layer creates is 0600 — private state names the user's projects and
 * processes; nothing else may read it.
 *
 * This layer knows no document schema, holds no writer lease, and keeps
 * no ownership record: exclusive write authority is always a
 * boot-composed kernel-backed lease acquired before a store is ever
 * opened for mutation (the `registry-writer`/`edit-writer` leases of
 * `packages/runtime/kernel-lease`, #209 — a PID, owner row, or release
 * callback here would be a second, competing authority model, rejected
 * in #209's resolution). The consumers' typed projections (`registry/`
 * and the tombstone seam) own their documents; this module owns only
 * the bytes-on-disk discipline.
 */

const TEMP_SUFFIX = '.tmp';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * The file-level discipline over one injected directory — read, the
 * atomic write, existence, the atomic intra-directory rename, and the
 * idempotent delete. Names are bare file names within the directory;
 * nothing here knows a schema.
 */
export interface FixedFileStore {
  /** A file's bytes, or `null` when absent. */
  read(name: string): Promise<string | null>;
  /** Temp → fsync → atomic rename → directory fsync, as mode 0600. */
  writeAtomically(name: string, contents: string): Promise<void>;
  /** Whether a file exists (mode checked at open, not here). */
  exists(name: string): Promise<boolean>;
  /** Atomic replacement of one managed file by another, with the directory fsync. */
  rename(from: string, to: string): Promise<void>;
  /** Deletes a file if present; never throws for absence. */
  delete(name: string): Promise<void>;
}

/**
 * Opens the store over the named fixed files: creates the directory
 * (recursive, 0700) if absent, enforces 0700 on it, and enforces 0600
 * on every named file and its temp sibling already present — a
 * directory created by an installer or a file restored from a backup
 * with looser modes is tightened, not trusted.
 */
export async function openFixedFileStore(
  directory: string,
  fileNames: readonly string[],
): Promise<FixedFileStore> {
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  // mkdir's mode is filtered by umask and ignored when the directory
  // already exists — chmod is the enforcement, mkdir the creation.
  await chmod(directory, DIRECTORY_MODE);
  const tightenTargets: readonly string[] = [
    ...fileNames,
    ...fileNames.map((n) => `${n}${TEMP_SUFFIX}`),
  ];
  for (const name of tightenTargets) {
    if (await existsIn(directory, name)) {
      await chmod(join(directory, name), FILE_MODE);
    }
  }

  return {
    read: (name) => readIn(directory, name),
    writeAtomically: (name, contents) => writeAtomicallyIn(directory, name, contents),
    exists: (name) => existsIn(directory, name),
    rename: (from, to) => renameIn(directory, from, to),
    delete: (name) => deleteIn(directory, name),
  };
}

async function existsIn(directory: string, name: string): Promise<boolean> {
  try {
    await stat(join(directory, name));
    return true;
  } catch (error) {
    if (isNoEntityError(error)) return false;
    throw error;
  }
}

async function readIn(directory: string, name: string): Promise<string | null> {
  try {
    return await readFile(join(directory, name), 'utf8');
  } catch (error) {
    if (isNoEntityError(error)) return null;
    throw error;
  }
}

async function writeAtomicallyIn(directory: string, name: string, contents: string): Promise<void> {
  const tempPath = `${join(directory, name)}${TEMP_SUFFIX}`;
  const handle = await open(tempPath, 'w', FILE_MODE);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  // POSIX rename over an existing file is the atomic replacement; a
  // leftover temp from a crashed earlier write is simply overwritten.
  await rename(tempPath, join(directory, name));
  await syncDirectory(directory);
}

async function renameIn(directory: string, from: string, to: string): Promise<void> {
  await rename(join(directory, from), join(directory, to));
  await syncDirectory(directory);
}

async function deleteIn(directory: string, name: string): Promise<void> {
  try {
    await unlink(join(directory, name));
  } catch (error) {
    if (!isNoEntityError(error)) throw error;
  }
}

/**
 * The directory fsync of the write discipline: persists the rename
 * itself, so a post-rename crash cannot resurrect the old file name
 * over the new bytes (or an emptied name over persisted bytes — the
 * delete/rename consumers rely on the same durability). Opening a
 * directory read-only for fsync is the POSIX pattern; on the qualified
 * local filesystems (APFS, ext4 — #209's environment set) this is
 * always permitted for the directory owner.
 */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNoEntityError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
