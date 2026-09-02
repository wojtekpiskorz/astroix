import { randomBytes } from 'node:crypto';
import { constants as fsConstants, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { WriteFailureCode } from './write-outcomes.ts';

/**
 * The commit mechanics (#224, ADR-0006 §6): the write discipline every
 * accepted operation's bytes pass through, after final validation.
 *
 * Existing-file replacement follows the registry-store idiom (#221,
 * ADR-0006 §2) transplanted onto managed project files: a
 * same-directory temporary file (a leftover temp from a crashed write
 * can never strand data on another filesystem or race the rename), file
 * `fsync`, atomic POSIX rename over the target, then a directory `fsync`
 * so a post-rename crash cannot resurrect the old name over the new
 * bytes. The one deliberate divergence from the private-state idiom is
 * the mode: registry files are enforced `0600`, but a managed project
 * file belongs to the developer — the replacement preserves the exact
 * permission bits the final validation observed (`fchmod`, never umask
 * hope), so an edit never silently rewrites the project's file mode.
 *
 * Creation is exclusive (`O_CREAT | O_EXCL | O_NOFOLLOW`): the
 * expected-absent baseline stays race-safe to the very syscall — a slot
 * filled between final validation and creation fails `EEXIST` rather
 * than overwriting, and a symlink planted on the slot is refused, never
 * followed. New files adopt the project's umask (open mode 0666, no
 * fchmod) — there are no prior bits to preserve.
 *
 * The directory `fsync` after a resolved rename/creation is the
 * discipline's durability tail, and its failure is deliberately NOT a
 * failed outcome: once the atomic replacement has resolved, the write
 * has landed — the outcome reports landing, and a durability lag on a
 * local filesystem that refused the directory sync is environmental,
 * not a write-outcome fact. Everything BEFORE the rename (temp write,
 * file fsync, mode enforcement) fails as `write-failed`/`create-failed`
 * with the original provably untouched.
 */

/** A typed commit failure — which discipline step failed; the original file is intact on every one. */
export class CommitError extends Error {
  readonly code: WriteFailureCode;

  constructor(code: WriteFailureCode) {
    super(`the commit discipline failed (${code})`);
    this.name = 'CommitError';
    this.code = code;
  }
}

/** The temporary-file species this layer creates — hidden, single-purpose, crash-leftover-safe. */
const TEMP_PREFIX = '.astroix-write-';
const TEMP_SUFFIX = '.tmp';
/** New files adopt the project's umask from this open mode; nothing here forces a mode on creation. */
const CREATION_MODE = 0o666;

/**
 * Replaces one existing canonical target's whole contents: same-directory
 * temp → write → file fsync → mode enforcement → atomic rename →
 * directory fsync. `mode` is the exact permission bits to preserve (what
 * final validation's lstat observed). A failure before the rename removes
 * the temp (best effort) and leaves the target untouched.
 */
export async function replaceExisting(
  canonicalPath: string,
  contents: string,
  mode: number,
): Promise<void> {
  const tempPath = join(dirname(canonicalPath), `${TEMP_PREFIX}${randomTempId()}${TEMP_SUFFIX}`);
  try {
    const handle = await open(tempPath, 'w', CREATION_MODE);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      // fchmod on the live handle: open's mode is umask-filtered, mode
      // preservation is enforcement.
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
  } catch {
    await discardTemp(tempPath);
    throw new CommitError('write-failed');
  }
  try {
    await rename(tempPath, canonicalPath);
  } catch {
    await discardTemp(tempPath);
    throw new CommitError('replace-failed');
  }
  await syncDirectoryBestEffort(dirname(canonicalPath));
}

/**
 * Creates one new file exclusively under its contained canonical parent:
 * `O_CREAT | O_EXCL | O_NOFOLLOW` — the expected-absent contract holds at
 * the syscall. File fsync, then directory fsync; no rename is involved.
 */
export async function createExclusive(
  canonicalParent: string,
  fileName: string,
  contents: string,
): Promise<void> {
  const targetPath = join(canonicalParent, fileName);
  try {
    const handle = await open(
      targetPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      CREATION_MODE,
    );
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    throw new CommitError('create-failed');
  }
  await syncDirectoryBestEffort(canonicalParent);
}

/** Best-effort temp removal — a leftover temp must never outlive a failed attempt when it can be removed. */
async function discardTemp(tempPath: string): Promise<void> {
  try {
    await unlink(tempPath);
  } catch {
    // the temp is already gone (or never landed) — nothing to clean
  }
}

function randomTempId(): string {
  return randomBytes(12).toString('hex');
}

/**
 * The durability tail (the registry store's directory-fsync pattern).
 * Opening a directory read-only for fsync is the POSIX pattern; on the
 * qualified local filesystems (APFS, ext4 — #209's environment set) this
 * is always permitted for the directory owner. Its failure is swallowed
 * by design — see the module docstring's honesty calculus.
 */
async function syncDirectoryBestEffort(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // the rename/creation already resolved — the write has landed; a
    // refused directory sync is environmental, not a write-outcome fact
  }
}
