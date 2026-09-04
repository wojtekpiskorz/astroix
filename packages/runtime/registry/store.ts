import { type FixedFileStore, openFixedFileStore } from '../persistence/fixed-file-store.ts';

/**
 * The registry store (ADR-0006 §2 "Persistence"; #221 AC): the fixed-file
 * discipline under one injected directory — the registry document, its
 * last-known-good mirror, and the quarantine side-file. The discipline
 * itself (same-directory temporary file, file fsync, atomic rename,
 * directory fsync, 0700/0600 enforcement, idempotent delete) is the ONE
 * shared implementation of `packages/runtime/persistence` (#329); this
 * module is the registry's typed projection over it — every write a
 * crash-atomic whole-file replacement, modes enforced not assumed
 * (registry state names the user's projects; nothing else may read it).
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
 * Opens the store over the shared fixed-file discipline: the directory
 * is created (recursive, 0700) and enforced, and every registry file
 * and temp sibling already present is tightened to 0600 — a directory
 * created by an installer or a file restored from a backup with looser
 * modes is tightened, not trusted.
 */
export async function openRegistryStore(directory: string): Promise<RegistryStore> {
  const names: readonly RegistryFileName[] = [REGISTRY_FILE, LAST_KNOWN_GOOD_FILE, QUARANTINE_FILE];
  const store: FixedFileStore = await openFixedFileStore(directory, names);

  return {
    read: (name) => store.read(name),
    writeAtomically: (name, contents) => store.writeAtomically(name, contents),
    exists: (name) => store.exists(name),
    quarantineCurrent: () => quarantineCurrentWith(store),
    delete: (name) => store.delete(name),
  };
}

/** Moves the current document to the quarantine file — the discipline's atomic intra-directory rename. */
async function quarantineCurrentWith(store: FixedFileStore): Promise<boolean> {
  if (!(await store.exists(REGISTRY_FILE))) return false;
  await store.rename(REGISTRY_FILE, QUARANTINE_FILE);
  return true;
}
