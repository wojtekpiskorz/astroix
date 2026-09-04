import type { WriteLoopState } from '../../editor/edit-drain/write-loop-state.ts';

/**
 * The CSS write surface's status derivation (#250, I2): the one
 * vocabulary the panel's write line renders — the machine's phase,
 * the scheduler's pending pause, and the conflict's stable state
 * folded into the words a user reads. Sanitized by construction: the
 * codes are the loop's own admission vocabulary or the protocol's
 * public codes, never raw error text.
 */

/** The write line's state word — `data-write-state` on the badge. */
export type CssWriteStatusState =
  | 'quiet'
  | 'scheduled'
  | 'writing'
  | 'saved'
  | 'conflict'
  | 'rejected'
  | 'uncertain';

/** The derived status — the state word plus the sanitized detail it carries. */
export interface CssWriteStatus {
  readonly state: CssWriteStatusState;
  /** The rejection/conflict code (`rejected`/`conflict` only), sanitized. */
  readonly code: string | null;
  /** The revision-conflict handback (`conflict` only) — the disk-truth SHA. */
  readonly conflictSha256: string | null;
}

/** Derives the status from the machine's state plus the pending-schedule truth. */
export function cssWriteStatusOf(write: WriteLoopState, pendingSchedules: number): CssWriteStatus {
  if (write.phase === 'pending' || write.phase === 'refresh-required') {
    return { state: 'writing', code: null, conflictSha256: null };
  }
  if (write.phase === 'committed') {
    return { state: 'saved', code: null, conflictSha256: null };
  }
  if (write.phase === 'irreversible-postcommit') {
    return { state: 'uncertain', code: write.code ?? null, conflictSha256: null };
  }
  if (write.phase === 'rejected') {
    if (write.code === 'revision-conflict') {
      return {
        state: 'conflict',
        code: write.code,
        conflictSha256: write.conflictSha256,
      };
    }
    return { state: 'rejected', code: write.code, conflictSha256: null };
  }
  // idle: a pending debounce is the scheduled pause, quiet otherwise.
  return {
    state: pendingSchedules > 0 ? 'scheduled' : 'quiet',
    code: null,
    conflictSha256: null,
  };
}

/** The status line's text — one sanitized sentence per state. */
export function cssWriteStatusText(status: CssWriteStatus): string {
  switch (status.state) {
    case 'quiet':
      return 'auto-write: idle';
    case 'scheduled':
      return 'auto-write: paused — will write…';
    case 'writing':
      return 'auto-write: writing…';
    case 'saved':
      return 'auto-write: saved';
    case 'conflict':
      return `auto-write: conflict — the file changed on disk (current baseline ${
        status.conflictSha256?.slice(0, 12) ?? 'unknown'
      }…)`;
    case 'rejected':
      return `auto-write: refused (${status.code ?? 'unknown'})`;
    case 'uncertain':
      return 'auto-write: outcome could not be confirmed — the served truth below is authoritative';
  }
}
