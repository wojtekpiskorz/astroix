import {
  chmodSync,
  closeSync,
  fchmodSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { classifySqliteBusyShape } from './busy-shape.ts';

/**
 * KernelLeaseModule — the lifetime-held, kernel-backed exclusive writer
 * lease proved by [#209](https://github.com/wojtekpiskorz/astroix/issues/209)
 * and normed by ADR-0006 §2/§6: each fixed private SQLite file is opened
 * with stock `node:sqlite` `DatabaseSync` (`allowExtension: false`,
 * `defensive: true`, `timeout: 0`, rollback journal `delete`) and holds
 * `BEGIN IMMEDIATE` until the operating-system process exits. Separate
 * files let the two distinct authorities coexist (`registry-writer` for
 * the control-plane child, `edit-writer` for a session's disposable write
 * executor) while same-name contenders stay exclusive.
 *
 * The module boundary is exactly the interface below (CONTEXT.md: kernel
 * lease): no database handle, no lease path, no PID, no owner record, no
 * generic caller-selected name, no release callback, no unlink, no
 * heartbeat, no expiry, no stale-owner recovery. One module instance holds
 * one lifetime authority; **process exit is the release boundary**, so
 * successful exclusive acquisition is the only same-boot proof that no
 * live holder remains. Nothing here ever consults `PATH`, spawns, or
 * shells out — the lease is file-descriptor and SQLite locking only, which
 * is what the poisoned-PATH gate relies on.
 *
 * Fail-closed discipline (#209's per-pin qualification): only the exact
 * busy shape on the exact qualified runtime pin maps to contention
 * (`ASTROIX_KERNEL_LEASE_UNAVAILABLE`). A wrong Node pin, a drifted
 * embedded SQLite source ID, an unexpected journal mode, extensions that
 * could be enabled, or a drifted busy shape fails as
 * `ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED`. Unknown failures never
 * become successful contention.
 *
 * Filesystem modes are enforced, not assumed (the registry-store
 * discipline): the private state directory is created `0700` and
 * tightened if looser; each fixed lease file is created `0600` (or
 * tightened), never followed through a symlink (`O_NOFOLLOW`), and
 * rejected when it is not a regular file with no other hard link
 * (`nlink ≠ 1`).
 *
 * The lease files are leases only — registry JSON persistence stays with
 * `packages/runtime/registry` (D2, #221); this layer holds no document
 * state.
 */

/** The exact Node pin the adapter was qualified on (#209 resolution). */
export const QUALIFIED_NODE_VERSION = 'v24.20.0';

/**
 * The embedded SQLite source ID of the qualified pin (3.53.4,
 * `2026-07-24 19:02:57 bf7c7f30…`). `node:sqlite` is Stability 1.2: every
 * bundled-Node pin change starts unqualified and must rerun the full
 * two-platform #209 matrix before release; comparing the live source ID
 * against this pin is the per-boot tripwire for that drift.
 */
export const QUALIFIED_SQLITE_SOURCE_ID =
  '2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc';

/** The runtime a boot composition declares this process was launched as. */
export interface QualifiedRuntimePin {
  readonly nodeVersion: string;
  readonly sqliteSourceId: string;
}

/**
 * The production pin. Packaged boots compose with exactly this; dev and
 * test compositions that genuinely run another Node declare
 * `currentRuntimePin()` instead — an explicit statement of the runtime in
 * use, never a fallback (no code path relaxes the pin check).
 */
export const QUALIFIED_RUNTIME_PIN: QualifiedRuntimePin = {
  nodeVersion: QUALIFIED_NODE_VERSION,
  sqliteSourceId: QUALIFIED_SQLITE_SOURCE_ID,
};

/** The runtime actually running this process, read live from `node:sqlite`. */
export function currentRuntimePin(): QualifiedRuntimePin {
  const probe = new DatabaseSync(':memory:');
  try {
    const row = probe.prepare('SELECT sqlite_source_id() AS sourceId').get();
    return { nodeVersion: process.version, sqliteSourceId: String(row?.sourceId ?? '') };
  } finally {
    probe.close();
  }
}

/** The closed failure-code set — sanitized, static messages, no system text. */
export type KernelLeaseErrorCode =
  | 'ASTROIX_KERNEL_LEASE_UNAVAILABLE'
  | 'ASTROIX_KERNEL_LEASE_ALREADY_HELD'
  | 'ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED'
  | 'ASTROIX_KERNEL_LEASE_STORAGE_UNSUPPORTED'
  | 'ASTROIX_KERNEL_LEASE_FAILED';

const KERNEL_LEASE_MESSAGES: Record<KernelLeaseErrorCode, string> = {
  ASTROIX_KERNEL_LEASE_UNAVAILABLE:
    'Astroix cannot acquire this kernel lease because another live process owns it; Astroix will not continue without exclusive ownership',
  ASTROIX_KERNEL_LEASE_ALREADY_HELD: 'This process already owns its lifetime-held kernel lease',
  ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED:
    'Astroix cannot start because the bundled runtime failed kernel-lease qualification; requalify the runtime pin before release',
  ASTROIX_KERNEL_LEASE_STORAGE_UNSUPPORTED:
    'Astroix cannot establish this kernel lease on the private state filesystem; use a supported local filesystem',
  ASTROIX_KERNEL_LEASE_FAILED:
    'Astroix cannot establish this kernel lease on the private local state filesystem; Astroix will not continue',
};

export class KernelLeaseError extends Error {
  readonly code: KernelLeaseErrorCode;
  /** Contention is terminal for this process too — a successor process retries, this one does not. */
  readonly retryable = false;

  constructor(code: KernelLeaseErrorCode, message: string = KERNEL_LEASE_MESSAGES[code]) {
    super(message);
    this.name = 'KernelLeaseError';
    this.code = code;
  }
}

/** The #209 module boundary — exactly two lifetime holds, nothing else. */
export interface KernelLeaseModule {
  /** The control-plane child's exclusive registry write authority. */
  holdRegistryWriter(): void;
  /** A session write executor's exclusive app-global edit authority. */
  holdEditWriter(): void;
}

export interface KernelLeaseOptions {
  /** Directory holding the two fixed private lease files (enforced 0700). */
  readonly privateStateDirectory: string;
  /**
   * The runtime pin this process was launched as; defaults to the
   * qualified production pin (#209) — anything else fails closed as
   * `ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED`.
   */
  readonly qualifiedRuntime?: QualifiedRuntimePin;
}

/** The fixed lease names — the only two authorities that exist (ADR-0006). */
type KernelLeaseName = 'registry-writer' | 'edit-writer';

const LEASE_FILES: Readonly<Record<KernelLeaseName, string>> = Object.freeze({
  'registry-writer': 'registry-writer.sqlite',
  'edit-writer': 'edit-writer.sqlite',
});

const PRIVATE_DIRECTORY_MODE = 0o700;
const LEASE_FILE_MODE = 0o600;

interface HeldLease {
  readonly lease: KernelLeaseName;
  readonly database: DatabaseSync;
}

/**
 * Opens the lease module. Fails immediately (`ASTROIX_KERNEL_LEASE_`
 * `RUNTIME_UNQUALIFIED`) when the running Node is not the declared pin —
 * before any file is touched.
 */
export function createKernelLeaseModule(options: KernelLeaseOptions): KernelLeaseModule {
  const privateStateDirectory = options.privateStateDirectory;
  if (typeof privateStateDirectory !== 'string' || privateStateDirectory.length === 0) {
    throw new TypeError('privateStateDirectory is required');
  }
  const qualifiedRuntime = options.qualifiedRuntime ?? QUALIFIED_RUNTIME_PIN;
  if (process.version !== qualifiedRuntime.nodeVersion) {
    throw new KernelLeaseError('ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED');
  }

  const state: { held: HeldLease | null } = { held: null };

  function hold(lease: KernelLeaseName): void {
    if (state.held !== null) {
      throw new KernelLeaseError('ASTROIX_KERNEL_LEASE_ALREADY_HELD');
    }
    let database: DatabaseSync | undefined;
    try {
      const path = prepareLeaseFile(privateStateDirectory, lease);
      database = openLeaseDatabase(path);
      assertQualifiedRuntime(database, qualifiedRuntime);
      database.exec('BEGIN IMMEDIATE');
      if (!database.isTransaction) {
        throw new KernelLeaseError('ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED');
      }
      state.held = { lease, database };
      database = undefined; // ownership transferred to the lifetime hold — never closed
    } catch (error) {
      discardFailedAcquisition(database);
      throw translateAcquisitionError(error, lease);
    }
  }

  return Object.freeze({
    holdRegistryWriter: () => hold('registry-writer'),
    holdEditWriter: () => hold('edit-writer'),
  });
}

/** Creates/tightens the fixed lease file and returns its path; storage-unsupported failures fail closed. */
function prepareLeaseFile(privateStateDirectory: string, lease: KernelLeaseName): string {
  mkdirSync(privateStateDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  // mkdir's mode is filtered by umask and ignored when the directory
  // already exists — chmod is the enforcement, mkdir the creation.
  chmodSync(privateStateDirectory, PRIVATE_DIRECTORY_MODE);
  const path = join(privateStateDirectory, LEASE_FILES[lease]);
  const descriptor = openSync(
    path,
    fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    LEASE_FILE_MODE,
  );
  try {
    fchmodSync(descriptor, LEASE_FILE_MODE);
  } finally {
    closeSync(descriptor);
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.nlink !== 1) {
    throw new KernelLeaseError('ASTROIX_KERNEL_LEASE_STORAGE_UNSUPPORTED');
  }
  return path;
}

/** The exact #209 DatabaseSync shape: defensive, extensions off, timeout 0. */
function openLeaseDatabase(path: string): DatabaseSync {
  return new DatabaseSync(path, {
    allowExtension: false,
    defensive: true,
    open: true,
    readOnly: false,
    timeout: 0,
  });
}

/** The in-acquisition qualification gates: journal, extensions, embedded SQLite pin. */
function assertQualifiedRuntime(
  database: DatabaseSync,
  qualifiedRuntime: QualifiedRuntimePin,
): void {
  const journalMode = database.prepare('PRAGMA journal_mode').get()?.journal_mode;
  if (journalMode !== 'delete') {
    throw new KernelLeaseError('ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED');
  }
  if (!extensionsAreLocked(database)) {
    throw new KernelLeaseError('ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED');
  }
  const sourceId = String(
    database.prepare('SELECT sqlite_source_id() AS sourceId').get()?.sourceId ?? '',
  );
  if (sourceId !== qualifiedRuntime.sqliteSourceId) {
    throw new KernelLeaseError('ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED');
  }
}

/**
 * `allowExtension: false` must make `enableLoadExtension(true)` fail with
 * `ERR_INVALID_STATE`; any other outcome (silence or an unexpected error)
 * is unqualified drift, never a successful disable.
 */
function extensionsAreLocked(database: DatabaseSync): boolean {
  try {
    database.enableLoadExtension(true);
  } catch (error) {
    return errorPropertyOf(error, 'code') === 'ERR_INVALID_STATE';
  }
  return false;
}

/** Rolls back and closes a connection from a failed acquisition — a successful hold is never closed. */
function discardFailedAcquisition(database: DatabaseSync | undefined): void {
  if (database === undefined) return;
  try {
    if (database.isTransaction) database.exec('ROLLBACK');
  } finally {
    database.close();
  }
}

/** Maps any acquisition failure onto the closed code set — fail closed, never into contention. */
function translateAcquisitionError(error: unknown, lease: KernelLeaseName): KernelLeaseError {
  if (error instanceof KernelLeaseError) return error;
  const shape = classifySqliteBusyShape(error);
  if (shape === 'qualified-contention') {
    return new KernelLeaseError('ASTROIX_KERNEL_LEASE_UNAVAILABLE');
  }
  if (shape === 'unqualified-busy') {
    return new KernelLeaseError('ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED');
  }
  return new KernelLeaseError(
    'ASTROIX_KERNEL_LEASE_FAILED',
    `${KERNEL_LEASE_MESSAGES.ASTROIX_KERNEL_LEASE_FAILED} (${lease})`,
  );
}

function errorPropertyOf(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as Record<string, unknown>)[key];
}
