import { type FixedFileStore, openFixedFileStore } from '../../persistence/fixed-file-store.ts';

/**
 * The tombstone store (#239, F7; ADR-0006 §4 "atomically persist"): the
 * tombstone's typed projection over the ONE shared fixed-file
 * discipline of `packages/runtime/persistence` (#329 — the registry
 * store's discipline, D2 #221, single-homed there): same-directory
 * temporary file, file fsync, atomic rename, directory fsync, so a
 * crash at any point leaves either the whole previous tombstone or the
 * whole new one, never a torn byte sequence and never a rename the
 * directory forgot. Modes are enforced, not assumed: the directory is
 * 0700 and the file 0600 (the record names the user's project and a
 * PID — private state, nothing else may read it).
 *
 * This layer holds no boot scope, no lease, and no ownership model: the
 * blocking and recovery semantics live in the sibling machine
 * (`boot-tombstone.ts`); the exclusive edit-writer lease that proves
 * recovery safety is the D3 kernel lease, never a file this layer owns.
 */

/** The one tombstone file — a single record stands at a time (the latest incomplete reap). */
export const TOMBSTONE_FILE = 'tombstone.json';

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
 * Opens the store over the shared fixed-file discipline: the directory
 * is created (recursive, 0700) and enforced, and the tombstone file and
 * its temp sibling are tightened to 0600 when present — a directory
 * created by an installer or a file restored from a backup with looser
 * modes is tightened, not trusted.
 */
export async function openTombstoneStore(directory: string): Promise<TombstoneStore> {
  const store: FixedFileStore = await openFixedFileStore(directory, [TOMBSTONE_FILE]);

  return {
    read: () => store.read(TOMBSTONE_FILE),
    writeAtomically: (contents) => store.writeAtomically(TOMBSTONE_FILE, contents),
    delete: () => store.delete(TOMBSTONE_FILE),
  };
}
