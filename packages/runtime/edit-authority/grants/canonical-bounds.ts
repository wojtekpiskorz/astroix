import { createHash } from 'node:crypto';
import { sep } from 'node:path';
import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';

/**
 * The canonical facts a grant binds (#223): containment judged on
 * REALPATH-resolved paths — never lexical-only (ADR-0006 §6: containment
 * for creation parents must be canonical; an internal symlink is editable
 * only while its resolved target stays inside the root, an external one
 * receives no grant) — session-pair equality, and the SHA-256 digest
 * species the inspections mint. No parallel revision space is invented
 * here: the digest is exactly E4's entry revision
 * (`content-result.ts`: "SHA-256 hex over the entry file's bytes at pass
 * time (the grant baseline)"), recomputed only to verify that discovery's
 * value is still the world's truth — the same expression
 * `entry-baselines.ts` reads files with.
 */

/**
 * Whether a canonical path is strictly inside the canonical root. Both
 * inputs are `fs.realpath` results — the comparison is canonical because
 * the resolution already happened; running it on unresolved spellings is
 * the lexical-only containment this module exists to avoid.
 */
export function isCanonicalDescendant(root: string, path: string): boolean {
  return path.startsWith(`${root}${sep}`);
}

/**
 * Whether a canonical directory may serve as a creation parent: the root
 * itself or any descendant of it (a project may create directly at its
 * root, but never at or beside it).
 */
export function isCreationParent(root: string, parent: string): boolean {
  return parent === root || isCanonicalDescendant(root, parent);
}

/**
 * Exact `SessionRef` pair equality (ADR-0006 §3): both the epoch and the
 * generation must match — a new epoch with a coincidentally equal
 * generation number is a different session, and a same-epoch generation
 * bump is a different activation. Either drift is a cross-session grant.
 */
export function sameSession(a: SessionRef, b: SessionRef): boolean {
  return a.runtimeEpoch === b.runtimeEpoch && a.generation === b.generation;
}

/**
 * SHA-256 hex over bytes — the revision-contract currency of existing
 * text resources (ADR-0006 §6), identical to the inspection mint
 * (`entry-baselines.ts` `readEntryBaseline`).
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
