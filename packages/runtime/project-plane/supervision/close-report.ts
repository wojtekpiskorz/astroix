/**
 * The supervision close report (#231, ADR-0006 §8): one recursive,
 * bounded report for the whole project plane — the worker's own close
 * report folded in beside the sibling terminations, explicitly complete
 * or incomplete, sanitized categories only, and never a PID. This module
 * is the pure classifier; the supervisor supplies the observed facts and
 * consumes the report unchanged.
 */

/** Why the plane closed. `stopped`/`cancelled` are the caller's stop; the rest are terminal supervision causes. */
export type SupervisionStopReason =
  | 'stopped'
  | 'cancelled'
  | 'startup-timeout'
  | 'worker-crash'
  | 'managed-astro-crash';

/** Which exact sibling a fact is about. */
export type SupervisionChild = 'worker' | 'managed-astro';

/** The sanitized cleanup-failure categories a supervision close report can name (ADR-0006 §8). */
export type SupervisionCleanupCategory =
  /** A graceful close expected the worker's close report and it never arrived within the stop bound. */
  | 'worker-close-report'
  /** The worker's own close report arrived incomplete — its failures are the plane's failures. */
  | 'worker-cleanup-incomplete'
  /** The worker's exit was not observed within the reap bound after escalation. */
  | 'worker-reap'
  /** The managed dev server's exit was not observed within the reap bound after escalation. */
  | 'managed-astro-reap'
  /** A supervisor-owned readiness probe failed to settle after its sockets were aborted. */
  | 'probe-abort';

/** What the close sequence observed about each owned resource — honest accounting, never a guess. */
export interface SupervisionCloseAccounting {
  /** Whether the worker's own close report arrived (false when none was expected or it never came). */
  readonly workerReportReceived: boolean;
  /** Whether the worker's own cleanup completed (true when no report was ever expected). */
  readonly workerCleanupComplete: boolean;
  /** The worker's exit was observed within its bounds. */
  readonly workerReaped: boolean;
  /** The managed dev server's exit was observed within its bounds. */
  readonly managedAstroReaped: boolean;
  /** Every aborted readiness probe settled within the stop bound. */
  readonly probesSettled: boolean;
  /**
   * Which children were ended by SIGKILL — the stop ladder's escalation
   * after an ignored SIGTERM, or the crash law's synchronous sibling
   * reap (#365: a worker crash kills the managed dev server in the
   * terminal transition's own tick, no TERM rung). Escalation with a
   * successful reap is still complete cleanup.
   */
  readonly killEscalations: readonly SupervisionChild[];
}

/** The plane supervisor's close report: explicitly complete or incomplete, sanitized categories only, never a PID. */
export interface SupervisionCloseReport {
  readonly reason: SupervisionStopReason;
  readonly outcome: 'complete' | 'incomplete';
  readonly failures: readonly SupervisionCleanupCategory[];
  readonly accounting: SupervisionCloseAccounting;
}

/** The observed facts one close ran against. */
export interface SupervisionCloseFacts {
  readonly reason: SupervisionStopReason;
  /** A close report was expected from the worker: it had answered readiness and the worker itself did not crash. */
  readonly workerReportExpected: boolean;
  readonly workerReportReceived: boolean;
  /** The worker's own report outcome, when received; true when nothing claims otherwise. */
  readonly workerCleanupComplete: boolean;
  readonly workerReaped: boolean;
  readonly managedAstroReaped: boolean;
  readonly probesSettled: boolean;
  readonly killEscalations: readonly SupervisionChild[];
}

/**
 * Classifies one close into its report: every failure category in
 * stop-sequence order, `complete` exactly when none fired. A crash path
 * never fails the worker-report categories (a crashed worker cannot
 * report; its sibling cleanup is what the report judges).
 */
export function classifySupervisionClose(facts: SupervisionCloseFacts): SupervisionCloseReport {
  const failures = failedCategories(facts);
  return {
    reason: facts.reason,
    outcome: failures.length === 0 ? 'complete' : 'incomplete',
    failures,
    accounting: {
      workerReportReceived: facts.workerReportReceived,
      workerCleanupComplete: facts.workerCleanupComplete,
      workerReaped: facts.workerReaped,
      managedAstroReaped: facts.managedAstroReaped,
      probesSettled: facts.probesSettled,
      killEscalations: facts.killEscalations,
    },
  };
}

/** The close report's failure categories, in stop-sequence order. */
function failedCategories(facts: SupervisionCloseFacts): SupervisionCleanupCategory[] {
  const failures: SupervisionCleanupCategory[] = [];
  if (facts.workerReportExpected && !facts.workerReportReceived) {
    failures.push('worker-close-report');
  } else if (facts.workerReportReceived && !facts.workerCleanupComplete) {
    failures.push('worker-cleanup-incomplete');
  }
  if (!facts.workerReaped) failures.push('worker-reap');
  if (!facts.managedAstroReaped) failures.push('managed-astro-reap');
  if (!facts.probesSettled) failures.push('probe-abort');
  return failures;
}
