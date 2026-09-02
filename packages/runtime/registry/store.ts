import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The registry store (ADR-0006 §2 "Persistence"; #221 AC): the fixed-file
 * discipline under one injected directory — the registry document, its
 * last-known-good mirror, and the quarantine side-file. Every write is a
 * same-directory temporary file, file fsync, atomic rename, and a
 * directory fsync, so a crash at any point leaves either the whole
 * previous file or the whole new one, never a torn byte sequence and
 * never a rename the directory forgot while the data blocks were still
 * in flight. Modes are enforced, not assumed: the directory is 0700 and
 * every file this layer creates is 0600 (the AC's permission gate —
 * registry state names the user's projects; nothing else may read it).
 *
 * This layer holds no writer lease and no ownership record: exclusive
 * write authority is the boot-composed kernel-backed `registry-writer`
 * lease (#209, `packages/runtime/kernel-lease`, a sibling lane) acquired
 * before this store is ever opened for mutation. A PID, owner row, or
 * release callback here would be a second, competing authority model —
 * rejected in #209's resolution.
 */

/** The current registry document. */
export const REGISTRY_FILE = 'registry.json';
/** The separately maintained last-known-good snapshot (ADR-0006 §2). */
export const LAST_KNOWN_GOOD_FILE = 'registry.last-known-good.json';
/** Where an unusable current document is moved aside to, intact. */
export const QUARANTINE_FILE = 'registry.quarantined.json';

const TEMP_SUFFIX = '.tmp';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/** The file-level seam the registry composes; nothing here knows the document schema. */
export interface RegistryStore {
  /** A file's bytes, or `null` when absent. */
  read(name: RegistryFileName): Promise<string | null>;
  /** Temp → fsync → atomic rename → directory fsync, as mode 0600. */
  writeAtomically(name: RegistryFileName, contents: string): Promise<void>;
  /** Whether a file exists (mode checked separately by callers). */
  exists(name: RegistryFileName): Promise<boolean>;
  /** Moves the current document to the quarantine file (overwriting a previous quarantine). */
  quarantineCurrent(): Promise<boolean>;
  /** Deletes a file if present; never throws for absence. */
  delete(name: RegistryFileName): Promise<void>;
}

export type RegistryFileName =
  | typeof REGISTRY_FILE
  | typeof LAST_KNOWN_GOOD_FILE
  | typeof QUARANTINE_FILE;

/**
 * Opens the store: creates the directory (recursive, 0700) if absent and
 * enforces 0700 on it, and enforces 0600 on every registry file already
 * present — a directory created by an installer or a file restored from a
 * backup with looser modes is tightened, not trusted.
 */
export async function openRegistryStore(directory: string): Promise<RegistryStore> {
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  // mkdir's mode is filtered by umask and ignored when the directory
  // already exists — chmod is the enforcement, mkdir the creation.
  await chmod(directory, DIRECTORY_MODE);
  const names: readonly RegistryFileName[] = [REGISTRY_FILE, LAST_KNOWN_GOOD_FILE, QUARANTINE_FILE];
  for (const name of names) {
    if (await existsIn(directory, name)) {
      await chmod(join(directory, name), FILE_MODE);
    }
  }

  return {
    read: (name) => readIn(directory, name),
    writeAtomically: (name, contents) => writeAtomicallyIn(directory, name, contents),
    exists: (name) => existsIn(directory, name),
    quarantineCurrent: () => quarantineCurrentIn(directory),
    delete: (name) => deleteIn(directory, name),
  };
}

async function existsIn(directory: string, name: RegistryFileName): Promise<boolean> {
  try {
    await stat(join(directory, name));
    return true;
  } catch (error) {
    if (isNoEntityError(error)) return false;
    throw error;
  }
}

async function readIn(directory: string, name: RegistryFileName): Promise<string | null> {
  try {
    return await readFile(join(directory, name), 'utf8');
  } catch (error) {
    if (isNoEntityError(error)) return null;
    throw error;
  }
}

async function writeAtomicallyIn(
  directory: string,
  name: RegistryFileName,
  contents: string,
): Promise<void> {
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

async function quarantineCurrentIn(directory: string): Promise<boolean> {
  if (!(await existsIn(directory, REGISTRY_FILE))) return false;
  await rename(join(directory, REGISTRY_FILE), join(directory, QUARANTINE_FILE));
  await syncDirectory(directory);
  return true;
}

async function deleteIn(directory: string, name: RegistryFileName): Promise<void> {
  try {
    await unlink(join(directory, name));
  } catch (error) {
    if (!isNoEntityError(error)) throw error;
  }
}

/**
 * The directory fsync of the write discipline: persists the rename
 * itself, so a post-rename crash cannot resurrect the old file name over
 * the new bytes. Opening a directory read-only for fsync is the POSIX
 * pattern; on the qualified local filesystems (APFS, ext4 — #209's
 * environment set) this is always permitted for the directory owner.
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
