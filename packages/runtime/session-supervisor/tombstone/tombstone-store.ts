import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The tombstone store (#239, F7; ADR-0006 §4 "atomically persist"): the
 * registry store's fixed-file discipline (D2, #221) mirrored for the one
 * tombstone file — same-directory temporary file, file fsync, atomic
 * rename, directory fsync, so a crash at any point leaves either the
 * whole previous tombstone or the whole new one, never a torn byte
 * sequence and never a rename the directory forgot. Modes are enforced,
 * not assumed: the directory is 0700 and the file 0600 (the record
 * names the user's project and a PID — private state, nothing else may
 * read it).
 *
 * This layer holds no boot scope, no lease, and no ownership model: the
 * blocking and recovery semantics live in the sibling machine
 * (`boot-tombstone.ts`); the exclusive edit-writer lease that proves
 * recovery safety is the D3 kernel lease, never a file this layer owns.
 */

/** The one tombstone file — a single record stands at a time (the latest incomplete reap). */
export const TOMBSTONE_FILE = 'tombstone.json';

const TEMP_SUFFIX = '.tmp';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/** The file-level seam the boot machine composes; nothing here knows the document schema. */
export interface TombstoneStore {
  /** The file's bytes, or `null` when absent. */
  read(): Promise<string | null>;
  /** Temp → fsync → atomic rename → directory fsync, as mode 0600. */
  writeAtomically(contents: string): Promise<void>;
  /** Removes the tombstone — the one clearing operation (scope-mismatch or lease proof). */
  delete(): Promise<void>;
}

/**
 * Opens the store: creates the directory (recursive, 0700) if absent,
 * enforces 0700 on it, and enforces 0600 on the tombstone file and its
 * temp sibling when present — a directory created by an installer or a
 * file restored from a backup with looser modes is tightened, not
 * trusted.
 */
export async function openTombstoneStore(directory: string): Promise<TombstoneStore> {
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  // mkdir's mode is filtered by umask and ignored when the directory
  // already exists — chmod is the enforcement, mkdir the creation.
  await chmod(directory, DIRECTORY_MODE);
  const tightenTargets = [TOMBSTONE_FILE, `${TOMBSTONE_FILE}${TEMP_SUFFIX}`];
  for (const name of tightenTargets) {
    if (await existsIn(directory, name)) {
      await chmod(join(directory, name), FILE_MODE);
    }
  }

  return {
    read: () => readIn(directory),
    writeAtomically: (contents) => writeAtomicallyIn(directory, contents),
    delete: () => deleteIn(directory),
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

async function readIn(directory: string): Promise<string | null> {
  try {
    return await readFile(join(directory, TOMBSTONE_FILE), 'utf8');
  } catch (error) {
    if (isNoEntityError(error)) return null;
    throw error;
  }
}

async function writeAtomicallyIn(directory: string, contents: string): Promise<void> {
  const tempPath = `${join(directory, TOMBSTONE_FILE)}${TEMP_SUFFIX}`;
  const handle = await open(tempPath, 'w', FILE_MODE);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  // POSIX rename over an existing file is the atomic replacement; a
  // leftover temp from a crashed earlier write is simply overwritten.
  await rename(tempPath, join(directory, TOMBSTONE_FILE));
  await syncDirectory(directory);
}

async function deleteIn(directory: string): Promise<void> {
  try {
    await unlink(join(directory, TOMBSTONE_FILE));
  } catch (error) {
    if (!isNoEntityError(error)) throw error;
  }
}

/**
 * The directory fsync of the write discipline: persists the rename
 * itself, so a post-rename crash cannot resurrect an emptied name over
 * the persisted bytes (the registry store's POSIX pattern).
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
