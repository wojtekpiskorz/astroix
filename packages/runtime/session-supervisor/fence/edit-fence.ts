import type { WriteOutcome } from '../../edit-authority/executor/write-outcomes.ts';
import { writeFailure } from '../../edit-authority/executor/write-outcomes.ts';
import {
  classifyWriteOutcome,
  DRAIN_DEADLINE_MS,
  type DrainFailureCause,
  type DrainFailureDetail,
  type DrainOperationOutcome,
  type DrainReport,
  failedDrainFailure,
  timedOutDrainFailure,
} from './drain-report.ts';

/**
 * The EditFence (#237, F5; ADR-0006 §4 steps 2–4 and §9 `EditFence`):
 * the supervisor-side fence and the one bounded transition drain over a
 * session's edit admission. Fencing closes admission **synchronously**,
 * submits the client's pending debounces into the one serialized server
 * queue, and waits at most {@link DRAIN_DEADLINE_MS} for every accepted
 * operation to reach success, conflict, or failure — one drain, never a
 * client drain followed by a server drain.
 *
 * The laws this machine holds:
 *
 * - **Admission closure is synchronous** (§4 step 2): the instant
 *   `fence()` returns, `submit()` refuses — no editor input may join the
 *   accepted set after the fence. The pending-debounce flush runs inside
 *   the same synchronous call, after closure, so the flushed work is
 *   admitted by the fence itself rather than racing a concurrent submit;
 *   a throwing flush seam leaves the fence untouched (open, nothing
 *   half-fenced) — the transition never began.
 * - **One serialized queue** (§4 step 2): every accepted edit executes
 *   through the queue in admission order, one in flight — the same
 *   discipline D5's executor core enforces; this pump is its shape
 *   (outcome-before-settlement, and a rejecting seam converges to an
 *   honestly failed outcome, never a hung drain).
 * - **The five-second bound** (§4 step 2): the drain's `outcome` settles
 *   no later than the deadline tick — earlier when every accepted
 *   operation is terminal.
 * - **Conflict and write failure abort the ordinary transition** (§4
 *   step 3): every accepted operation is still settled (the queue drains
 *   to terminal — "settle accepted writes once"), the report carries the
 *   protocol failure and F4's rollback reason for the candidate rollback
 *   that follows, and the abort composes with old authority untouched —
 *   revocation ordering is F6's (#238), never this machine's. The
 *   verdict reads the whole sealed ledger: any non-success terminal
 *   outcome among accepted operations fails the drain, including one
 *   that settled before the fence (fail-closed, the ADR's plain "a
 *   conflict or write failure aborts"; the recovery is the retry —
 *   resume reopens admission and the next fence starts a fresh ledger).
 * - **The no-silent-work law** (§4 step 4 and the ticket's migration
 *   policy): a drain timeout is never a caller-only rejection while work
 *   continues unnoticed — the timed-out verdict is *resolved*, not
 *   thrown; the fence **stays fenced** (admission stays closed,
 *   `resume()` refuses), and the accepted work stays tracked: the queue
 *   keeps executing, `settled` stays pending, and only when the last
 *   accepted operation is terminal does the fence become resumable. The
 *   force path that may cut the waiting short is F6's.
 * - **resume is legal only after a terminal drain** (§4 steps 3–4):
 *   `drained`, `failed`, and the late terminality after a timeout
 *   (`terminal-after-timeout`) re-open admission; `draining` and
 *   `timed-out` refuse it. The *before revocation* half of the ADR's
 *   resume clause is the coordinator's ordering (F6 owns revocation and
 *   retires the whole session with its fence) — the declared-seam
 *   precedent of F4's paramless `commit()` and E8's proxy-health.
 * - **`revoke()` is F6's**, deliberately absent here: the force path,
 *   the one-use receipt, and post-revocation behavior belong to #238
 *   and #239 (the ticket's migration policy).
 *
 * Deterministic by construction: the machine owns no IO and no host
 * timers of its own — the one time dependency (the deadline) is the
 * injected {@link DrainClock}, and every queue behavior arrives through
 * each edit's `execute` thunk (in production edit-authority's dispatch
 * onto the D5 executor; the focused tests fake exactly that seam).
 */

/**
 * One edit the serialized server queue can execute: the debounce key
 * (sanitized reporting vocabulary — never a filesystem path) plus the
 * queue's own execution thunk, resolving with the executor's closed
 * terminal-outcome surface. Production thunks dispatch onto the D5
 * executor; the contract is resolve-with-outcome (a rejection is a
 * composition defect the machine still converges honestly).
 */
export interface QueuedEdit {
  readonly key: string;
  readonly execute: () => Promise<WriteOutcome>;
}

/**
 * The fence's state machine, the discriminant every edge is tested on:
 * `open` (admission open — initial, and again after `resume()`), the
 * live drain (`draining`), its terminal verdicts (`drained`, `failed`),
 * the deadline verdict (`timed-out` — fenced and tracking until the
 * accepted work settles), and the late terminality after a timeout
 * (`terminal-after-timeout` — the timed-out fence whose work all
 * settled; resumable, while its `outcome` report stays the timed-out
 * verdict it settled with — F6's receipt reads the report, never this
 * state).
 */
export type EditFenceState =
  | 'open'
  | 'draining'
  | 'drained'
  | 'failed'
  | 'timed-out'
  | 'terminal-after-timeout';

/** `submit()`'s answer: admitted into the queue with its terminal outcome, or refused synchronously (fenced). */
export type EditSubmission =
  | { readonly kind: 'accepted'; readonly outcome: Promise<DrainOperationOutcome> }
  | { readonly kind: 'refused' };

/** `fence()`'s answer: the begun drain, or the refusal (admission was already closed). */
export type FenceStart =
  | { readonly kind: 'fenced'; readonly drain: EditDrain }
  | { readonly kind: 'refused'; readonly reason: 'not-open' };

/** Why `resume()` refused — one code per illegal edge of the legality window. */
export type ResumeRefusal = 'not-fenced' | 'drain-in-flight' | 'work-not-terminal';

/** `resume()`'s answer: admission re-opened, or the structured refusal. */
export type ResumeResult =
  | { readonly kind: 'resumed' }
  | { readonly kind: 'refused'; readonly reason: ResumeRefusal };

/**
 * One transition's bounded drain (ADR-0006 §9 `EditFence`, F5's bounded
 * half): the verdict promise, the no-silent-work tracking promise, and
 * the resume operation whose legality the fence's state decides.
 */
export interface EditDrain {
  /**
   * The one drain's verdict — settles no later than the five-second
   * deadline, `drained`/`failed`/`timed-out`. It resolves, never
   * rejects: a timeout is a report the caller cannot accidentally
   * swallow while work continues unnoticed.
   */
  readonly outcome: Promise<DrainReport>;
  /**
   * Settles when **every** accepted operation is terminal — including
   * after a timeout verdict. This is the no-silent-work observable: it
   * stays pending exactly as long as accepted work is unsettled.
   */
  readonly settled: Promise<void>;
  /**
   * Re-opens admission. Legal only after a terminal drain (`drained`,
   * `failed`, or `terminal-after-timeout`); refuses while the drain is
   * in flight or a timed-out fence still has unsettled accepted work.
   */
  resume(): ResumeResult;
}

/**
 * The fence's one time dependency — the drain deadline. Injectable so
 * the focused tests never touch a real timer; the production clock arms
 * the host timer for exactly {@link DRAIN_DEADLINE_MS}.
 */
export interface DrainClock {
  /** Arms one deadline; the returned disarmer cancels it. */
  delay(ms: number, fire: () => void): () => void;
}

/** The production drain clock: the five-second deadline on the host timer. */
export function createHostDrainClock(): DrainClock {
  return {
    delay: (ms, fire) => {
      const handle = setTimeout(fire, ms);
      return () => {
        clearTimeout(handle);
      };
    },
  };
}

/** Construction options — the injected seams the focused tests fake. */
export interface EditFenceOptions {
  /** The drain clock; defaults to the host timer. */
  readonly clock?: DrainClock;
}

/** The fence and the session edit admission it governs. */
export interface EditFence {
  /** The state machine's discriminant — the single source for resume legality and admission. */
  readonly state: EditFenceState;
  /**
   * Admits one edit into the serialized queue. Refused **synchronously**
   * the moment the fence is closed (`fence()` until a legal `resume()`):
   * refused work was never accepted, so it has no outcome at all.
   */
  submit(edit: QueuedEdit): EditSubmission;
  /**
   * Closes admission synchronously, submits the client's pending
   * debounces into the one serialized queue, and begins the bounded
   * drain. The pending seam runs inside this call, after closure — the
   * flush is part of the same drain (one queue, one deadline, one
   * verdict), never a separate client drain. Refused unless the fence
   * is open.
   */
  fence(pending?: () => Iterable<QueuedEdit>): FenceStart;
}

/** One accepted edit's ledger entry — the drain tracks it until terminal. */
interface AcceptedEdit {
  readonly key: string;
  readonly execute: () => Promise<WriteOutcome>;
  /** Resolves the submitter's per-operation outcome promise. */
  readonly report: (outcome: DrainOperationOutcome) => void;
  phase: 'queued' | 'in-flight' | 'terminal';
}

/** Builds one EditFence over the injected clock. */
export function createEditFence(options: EditFenceOptions = {}): EditFence {
  const clock = options.clock ?? createHostDrainClock();

  let state: EditFenceState = 'open';
  let accepted: AcceptedEdit[] = [];
  let cursor = 0; // the next admission-order candidate to execute
  let terminalCount = 0;
  let inFlight = false;
  let firstFailure: DrainFailureDetail | null = null;

  // The live drain's settlement handles — the fence holds at most one
  // drain, so one resolver pair is exactly one drain's worth of state.
  let resolveOutcome: (report: DrainReport) => void = () => {};
  let resolveSettled: () => void = () => {};
  let disarm: (() => void) | null = null;

  const disarmDeadline = (): void => {
    disarm?.();
    disarm = null;
  };

  /**
   * Strict serialization, D5's pump shape: one accepted edit in flight,
   * the next admitted only after the previous settles. Runs regardless
   * of fence state — accepted work settles whatever the verdict was
   * (the no-silent-work law is the queue's own discipline too).
   */
  const pump = (): void => {
    if (inFlight) return;
    let op = accepted[cursor];
    while (op !== undefined && op.phase !== 'queued') {
      cursor += 1;
      op = accepted[cursor];
    }
    if (op === undefined) return;
    const current = op;
    current.phase = 'in-flight';
    inFlight = true;
    void current.execute().then(
      (raw) => {
        settle(current, raw);
      },
      () => {
        // A rejecting queue seam is a composition defect (the contract is
        // resolve-with-outcome); the operation still settles, honestly
        // failed, never pending forever — D5's own pump idiom.
        settle(current, writeFailure('write-failed'));
      },
    );
  };

  /** One accepted edit reached its terminal outcome — record, report, and advance the machine. */
  const settle = (op: AcceptedEdit, raw: WriteOutcome): void => {
    op.phase = 'terminal';
    const classified = classifyWriteOutcome(raw);
    op.report(classified);
    if (classified !== 'success' && firstFailure === null) {
      const cause: DrainFailureCause = classified === 'conflict' ? 'conflict' : 'write-failure';
      firstFailure = { key: op.key, cause, outcome: raw };
    }
    terminalCount += 1;
    inFlight = false;
    onTerminality();
    pump();
  };

  /**
   * The terminality convergence — after every settlement and after the
   * flush. When the last accepted edit is terminal: resolve the tracking
   * promise, and give the bounded verdict if the drain is still waiting
   * for one (disarming the deadline); a timed-out fence instead crosses
   * to `terminal-after-timeout` — its verdict was already given.
   */
  const onTerminality = (): void => {
    if (terminalCount !== accepted.length) return;
    resolveSettled();
    if (state === 'draining') {
      disarmDeadline();
      if (firstFailure === null) {
        state = 'drained';
        resolveOutcome({ kind: 'drained', settled: accepted.length });
      } else {
        state = 'failed';
        resolveOutcome({
          kind: 'failed',
          cause: firstFailure.cause,
          firstFailure,
          settled: accepted.length,
          failure: failedDrainFailure(),
          rollbackReason: 'drain-conflict',
        });
      }
    } else if (state === 'timed-out') {
      state = 'terminal-after-timeout';
    }
  };

  /**
   * The deadline tick: a verdict only while the drain is genuinely still
   * waiting — the state guard alone is the whole race discipline, because
   * terminality and its verdict move in one synchronous block: by the
   * time a tick can observe `terminalCount === accepted.length`, the
   * terminal verdict was already given and this is a late no-op (the
   * disarm is hygiene, never correctness). A real timeout resolves the
   * verdict report and leaves the fence fenced and tracking — the queue
   * and `settled` keep going on their own.
   */
  const onDeadline = (): void => {
    if (state !== 'draining') return;
    state = 'timed-out';
    resolveOutcome({
      kind: 'timed-out',
      settled: terminalCount,
      pending: accepted.length - terminalCount,
      failure: timedOutDrainFailure(),
      rollbackReason: 'drain-timeout',
    });
  };

  /** Admits one edit into the ledger, answering its per-operation outcome promise. */
  const admit = (edit: QueuedEdit): Promise<DrainOperationOutcome> => {
    let report: (outcome: DrainOperationOutcome) => void = () => {};
    const outcome = new Promise<DrainOperationOutcome>((resolve) => {
      report = resolve;
    });
    accepted.push({ key: edit.key, execute: edit.execute, report, phase: 'queued' });
    return outcome;
  };

  /** The drain handle's resume — the fence state is the legality window. */
  const resume = (): ResumeResult => {
    if (state === 'open') return { kind: 'refused', reason: 'not-fenced' };
    if (state === 'draining') return { kind: 'refused', reason: 'drain-in-flight' };
    if (state === 'timed-out') return { kind: 'refused', reason: 'work-not-terminal' };
    // drained | failed | terminal-after-timeout — every accepted operation
    // is terminal here by construction, so the sealed ledger retires whole
    // and the next drain starts a fresh one.
    state = 'open';
    accepted = [];
    cursor = 0;
    terminalCount = 0;
    firstFailure = null;
    return { kind: 'resumed' };
  };

  const fence: EditFence = {
    get state() {
      return state;
    },
    submit: (edit) => {
      if (state !== 'open') return { kind: 'refused' };
      const outcome = admit(edit);
      pump();
      return { kind: 'accepted', outcome };
    },
    fence: (pending) => {
      if (state !== 'open') return { kind: 'refused', reason: 'not-open' };
      // Admission closes FIRST: a re-entrant `fence()` from inside the
      // pending seam must hit `not-open`, and a `submit()` racing the
      // flush must not slip past the closure instant. The flush may then
      // throw: the state reverts to open and the transition is un-begun —
      // never a half-fenced machine.
      state = 'draining';
      let flushed: QueuedEdit[] = [];
      try {
        flushed = [...(pending?.() ?? [])];
      } catch (error) {
        state = 'open';
        throw error;
      }
      const outcome = new Promise<DrainReport>((resolve) => {
        resolveOutcome = resolve;
      });
      const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve;
      });
      const drain: EditDrain = { outcome, settled, resume };
      // The pending debounces enter the sealed ledger — the flush is part
      // of this drain: one queue, one deadline, one verdict.
      for (const edit of flushed) admit(edit);
      disarm = clock.delay(DRAIN_DEADLINE_MS, onDeadline);
      pump();
      onTerminality();
      return { kind: 'fenced', drain };
    },
  };
  return fence;
}
