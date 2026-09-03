import type { SessionFailure } from '@wojciechpiskorz/astroix-protocol';
import type { WriteOutcome } from '../../edit-authority/executor/write-outcomes.ts';
import { FAILURE_MESSAGES } from '../staging/activation-attempt.ts';

/**
 * The drain's closed vocabulary (#237, F5; ADR-0006 §4 steps 2–4): how one
 * accepted operation's terminal outcome reads at the drain, which failures
 * abort an ordinary transition, and the report the one bounded drain
 * settles with. Pure by construction — no timers, no IO; the machine that
 * produces these shapes lives in `edit-fence.ts`.
 *
 * The outcome species are exactly the ticket's three: **success**,
 * **conflict**, or **failure** (ADR-0006 §4 step 2: "every accepted
 * operation to reach a terminal result"). They classify the executor's
 * own closed outcome surface (D5 #224, read-only): a committed write is
 * success; the revision-conflict species (`changed-baseline` — an exact
 * SHA-256 precondition failed, `target-exists` — an expected-absent
 * precondition failed; the protocol's 409 `revision-conflict` codes) is
 * conflict; everything else that is not a clean commit is failure — IO
 * failures, policy rejections, and the honest `unknown` of a forced exit
 * can each prove a clean drain false, never true. The default is the
 * fail-closed direction: a rejection code not yet enumerated still reads
 * failure, so a new executor code can never silently count as success.
 */

/** The drain deadline — ADR-0006 §4 step 2: "wait up to **5 seconds**". The ticket's law, one constant. */
export const DRAIN_DEADLINE_MS = 5000;

/** How one accepted operation's terminal outcome reads at the drain — exactly the ticket's three species. */
export type DrainOperationOutcome = 'success' | 'conflict' | 'failure';

/** Why a drain failed on the write surface: a revision conflict, or a write that failed without conflicting. */
export type DrainFailureCause = 'conflict' | 'write-failure';

/** The first terminal failure a drain aborted on — the conflict report's own detail (the key, never a path). */
export interface DrainFailureDetail {
  /** The failing operation's debounce key — sanitized reporting vocabulary, never a filesystem path. */
  readonly key: string;
  readonly cause: DrainFailureCause;
  /** The executor's own terminal outcome — the closed surface the classification read. */
  readonly outcome: WriteOutcome;
}

/**
 * The one drain's verdict (ADR-0006 §9: "`EditFence.outcome` settles
 * within the 5-second drain deadline with a drained/failed/timed-out
 * report"). `drained` and `failed` are terminal — every accepted operation
 * settled; `timed-out` is the deadline's verdict and is **not** terminal:
 * the fence stays fenced and keeps tracking until the accepted work
 * settles (the no-silent-work law) or the force path (F6) takes over.
 */
export type DrainReport =
  | { readonly kind: 'drained'; readonly settled: number }
  | {
      readonly kind: 'failed';
      readonly cause: DrainFailureCause;
      readonly firstFailure: DrainFailureDetail;
      readonly settled: number;
      readonly failure: SessionFailure;
      readonly rollbackReason: 'drain-conflict';
    }
  | {
      readonly kind: 'timed-out';
      readonly settled: number;
      readonly pending: number;
      readonly failure: SessionFailure;
      readonly rollbackReason: 'drain-timeout';
    };

/**
 * Classifies one executor terminal outcome into the drain's three
 * species. The conflict set is exactly the revision-contract pair
 * (`changed-baseline`, `target-exists` — expected SHA-256 and
 * expected-absent preconditions, the protocol's `revision-conflict`);
 * every other non-commit outcome reads failure, `unknown` included —
 * an outcome that cannot prove the write landed can never count as a
 * clean drain.
 */
export function classifyWriteOutcome(outcome: WriteOutcome): DrainOperationOutcome {
  if (outcome.type === 'committed') return 'success';
  if (
    outcome.type === 'rejected' &&
    (outcome.code === 'changed-baseline' || outcome.code === 'target-exists')
  ) {
    return 'conflict';
  }
  return 'failure';
}

/**
 * The `SessionFailure` a failed drain records: category `drain-conflict`
 * — the closed wire set's one non-timeout drain category. Both write-
 * surface causes (conflict and write failure) abort identically
 * (ADR-0006 §4 step 3 treats them as one path), and the wire vocabulary
 * distinguishes only conflict from timeout, so the cause discriminant
 * rides this module's report while the wire category stays `drain-conflict`.
 */
export function failedDrainFailure(): SessionFailure {
  return { category: 'drain-conflict', message: FAILURE_MESSAGES['drain-conflict'] };
}

/** The `SessionFailure` a timed-out drain records — category `drain-timeout`, staging's fixed template. */
export function timedOutDrainFailure(): SessionFailure {
  return { category: 'drain-timeout', message: FAILURE_MESSAGES['drain-timeout'] };
}
