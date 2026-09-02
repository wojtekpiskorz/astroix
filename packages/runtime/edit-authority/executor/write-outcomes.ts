import type { Sha256Hex } from '@wojciechpiskorz/astroix-protocol';

/**
 * The executor's closed terminal-outcome surface (#224, ADR-0006 §6):
 * every accepted operation settles exactly once into one of these shapes,
 * and nothing else is ever reported. The executor is the last writer —
 * after its outcome the operation is terminal, success or not, and no
 * retry exists inside this lane (conflict handling and resubmission
 * belong to the fence/drain mechanics, F5).
 *
 * `unknown` is the honest terminal state born of forced termination: the
 * write executor's process died between final validation and the
 * atomic replacement (or while its outcome reply was still in flight),
 * so the rename may or may not have landed. The seam reports unknown —
 * it never guesses committed or failed from a world it can no longer
 * observe (ADR-0006 §4: "affected write outcomes are reported unknown").
 * Only the spawner side of the seam can produce it — a live executor
 * always knows whether its own rename resolved.
 */

/** The final-validation rejection codes — the checks repeated immediately before commit. */
export type WriteRejectionCode =
  | 'cross-session'
  | 'wrong-root'
  | 'operation-not-allowed'
  | 'operation-target-mismatch'
  | 'target-moved'
  | 'target-absent'
  | 'parent-absent'
  | 'parent-not-directory'
  | 'not-a-file'
  | 'hard-linked-target'
  | 'changed-baseline'
  | 'target-exists'
  | 'range-outside-baseline'
  /** Admission-time, not world-time: the executor is fenced/stopping and never accepted the work. */
  | 'fenced'
  /** Admission-time: the private-channel plan object failed closed structural validation. */
  | 'malformed-plan';

/** The commit-attempt IO failures — deterministic non-landing (the original is intact). */
export type WriteFailureCode = 'read-failed' | 'write-failed' | 'replace-failed' | 'create-failed';

/** Static, sanitized messages per code — no interpolated paths, errnos, or system text. */
const REJECTION_MESSAGES: Record<WriteRejectionCode, string> = {
  'cross-session': 'the write plan is bound to another session',
  'wrong-root': 'the write plan is bound to another canonical project root',
  'operation-not-allowed': 'the operation is not among the grant\u2019s allowed operations',
  'operation-target-mismatch': 'the operation does not fit the grant\u2019s target species',
  'target-moved':
    'the canonical target changed underneath the grant (containment or symlink drift)',
  'target-absent': 'the granted target no longer exists',
  'parent-absent': 'the creation parent no longer exists',
  'parent-not-directory': 'the creation parent is not a directory',
  'not-a-file': 'the granted target is not a regular file',
  'hard-linked-target': 'the target has more than one hard link',
  'changed-baseline': 'the resource no longer matches the grant\u2019s revision contract',
  'target-exists': 'the expected-absent creation target already exists',
  'range-outside-baseline': 'the splice range does not fit the verified baseline contents',
  fenced: 'the write executor is fenced and admits no new work',
  'malformed-plan': 'the dispatched plan failed the executor\u2019s closed shape validation',
};

const FAILURE_MESSAGES: Record<WriteFailureCode, string> = {
  'read-failed': 'the resource could not be read during final validation',
  'write-failed': 'the temporary file could not be written and synced',
  'replace-failed': 'the atomic replacement could not be performed',
  'create-failed': 'the exclusive creation could not be performed',
};

/**
 * One terminal write outcome. The revision on `committed` is the SHA-256
 * of the landed bytes — the revision-contract currency the follow-on
 * grant binds to (ADR-0006 §6), not the wire protocol's monotonic
 * inspection counter (that lift belongs to the edit-authority
 * composition above this seam).
 */
export type WriteOutcome =
  | { readonly type: 'committed'; readonly revision: Sha256Hex }
  | { readonly type: 'rejected'; readonly code: WriteRejectionCode; readonly message: string }
  | { readonly type: 'failed'; readonly code: WriteFailureCode; readonly message: string }
  | { readonly type: 'unknown' };

export function writeRejection(code: WriteRejectionCode): WriteOutcome {
  return { type: 'rejected', code, message: REJECTION_MESSAGES[code] };
}

export function writeFailure(code: WriteFailureCode): WriteOutcome {
  return { type: 'failed', code, message: FAILURE_MESSAGES[code] };
}

/** The executor's one admission-time error: work submitted after fencing — never accepted. */
export class ExecutorFencedError extends Error {
  constructor() {
    super(REJECTION_MESSAGES.fenced);
    this.name = 'ExecutorFencedError';
  }
}

/** The close report of a drained executor: every accepted operation reached a terminal outcome. */
export interface ExecutorCloseReport {
  readonly outcome: 'drained';
  /** How many accepted operations settled (committed, rejected, or failed — never unknown). */
  readonly settled: number;
}
