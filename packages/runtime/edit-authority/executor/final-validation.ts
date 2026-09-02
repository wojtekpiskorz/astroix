import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isCanonicalDescendant, isCreationParent, sha256Hex } from '../grants/canonical-bounds.ts';
import type { GrantedResource } from '../grants/grant-table.ts';

/**
 * The immediate-before-commit recheck (#224, ADR-0006 §6): the executor
 * repeats the world half of the grant law against the real filesystem
 * right before every commit — realpath (the canonical target must still
 * resolve to the exact canonical path the grant bound), lstat (regular
 * file, and for existing targets exactly one hard link), containment
 * (the re-resolved path must stay inside the canonical root — an
 * internal symlink whose target stays inside the root is editable, an
 * external one or a swapped link is refused), and the revision contract
 * (the current bytes re-read and re-digested against the exact SHA-256
 * baseline; creation slots re-checked expected-absent).
 *
 * This is deliberately an independent re-derivation, not a call into the
 * grant table's `verify`: the table lives in the control-plane process
 * and the executor writes from its own — the lstat→read window this
 * recheck owns is the disclosed optimistic-concurrency limit (ADR-0006
 * §6), and the residual race between this read and the atomic
 * replacement is exactly that limit, never a closed check.
 */

/**
 * The verified world state one commit proceeds from: the current text of
 * an existing target (the exact bytes the digest proved) plus its
 * preserved mode, or the confirmed-absent creation slot.
 */
export type FinalValidation =
  | {
      readonly ok: true;
      readonly kind: 'existing';
      readonly text: string;
      /** The target's current permission bits — the replacement preserves them exactly. */
      readonly mode: number;
    }
  | { readonly ok: true; readonly kind: 'creation' }
  | { readonly ok: false; code: FinalValidationCode; message: string };

/** The world-half rejection codes (the session/grant/operation halves live in the executor core). */
export type FinalValidationCode =
  | 'target-moved'
  | 'target-absent'
  | 'parent-absent'
  | 'parent-not-directory'
  | 'not-a-file'
  | 'hard-linked-target'
  | 'changed-baseline'
  | 'target-exists';

const MESSAGES: Record<FinalValidationCode, string> = {
  'target-moved': 'the canonical target changed underneath the grant',
  'target-absent': 'the granted target no longer exists',
  'parent-absent': 'the creation parent no longer exists',
  'parent-not-directory': 'the creation parent is not a directory',
  'not-a-file': 'the granted target is not a regular file',
  'hard-linked-target': 'the target has more than one hard link',
  'changed-baseline': 'the resource no longer matches the grant\u2019s revision contract',
  'target-exists': 'the expected-absent creation target already exists',
};

function invalid(code: FinalValidationCode): FinalValidation {
  return { ok: false, code, message: MESSAGES[code] };
}

/** Repeats the full world check for one granted existing-text resource. */
export async function validateExistingTarget(resource: GrantedResource): Promise<FinalValidation> {
  const target = resource.target;
  const baseline = resource.baseline;
  if (target.type !== 'existing' || baseline.type !== 'sha256') {
    // An incoherent resource never reaches the filesystem — the species
    // coherence check in the core maps this shape; here it fails closed.
    return invalid('changed-baseline');
  }
  let canonical: string;
  try {
    canonical = await realpath(target.canonicalPath);
  } catch {
    return invalid('target-absent');
  }
  if (
    canonical !== target.canonicalPath ||
    !isCanonicalDescendant(resource.canonicalRoot, canonical)
  ) {
    return invalid('target-moved');
  }
  const info = await lstat(canonical);
  if (!info.isFile()) return invalid('not-a-file');
  if (info.nlink > 1) return invalid('hard-linked-target');
  const bytes = await readFile(canonical);
  if (sha256Hex(bytes) !== baseline.sha256) return invalid('changed-baseline');
  return { ok: true, kind: 'existing', text: bytes.toString('utf8'), mode: info.mode & 0o7777 };
}

/** Repeats the full world check for one granted creation slot. */
export async function validateCreationTarget(resource: GrantedResource): Promise<FinalValidation> {
  const target = resource.target;
  if (target.type !== 'creation' || resource.baseline.type !== 'expected-absent') {
    return invalid('changed-baseline');
  }
  let parent: string;
  try {
    parent = await realpath(target.canonicalParent);
  } catch {
    return invalid('parent-absent');
  }
  if (parent !== target.canonicalParent) return invalid('target-moved');
  if (!isCreationParent(resource.canonicalRoot, parent)) return invalid('target-moved');
  if (!(await lstat(parent)).isDirectory()) return invalid('parent-not-directory');
  try {
    await lstat(join(parent, target.fileName));
  } catch (error) {
    if (isNoEntity(error)) return { ok: true, kind: 'creation' };
    throw error;
  }
  return invalid('target-exists');
}

function isNoEntity(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
