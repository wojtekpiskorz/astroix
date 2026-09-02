import type {
  AdapterErrorCode,
  AdapterErrorDetails,
} from '../../astro-project-adapter/adapter-error.ts';
import { AdapterError } from '../../astro-project-adapter/adapter-error.ts';
import type { StylesInspectionOutcome } from '../../astro-project-adapter/styles/convergence/converged-styles-inspection.ts';
import type { InspectionFamily, WorkerDiagnosticEvent } from './worker-events.ts';

/**
 * The worker's closed failure surface (#230): every rejected dispatch
 * carries a code from this set and a message composed from fixed
 * templates over closed enumerations — adapter codes, unconverged
 * outcomes, mismatch categories. The adapter's own guarantee closes the
 * chain: `AdapterError` messages and details are sanitized at their
 * construction (the guard refuses a leaky message there), and this layer
 * never forwards a raw `cause`, stack, or foreign message — the codes
 * and the adapter's sanctioned `details` shapes carry the facts
 * (ADR-0006 §7 output hygiene, the `adapter-error.ts` doctrine).
 */

/** The closed worker failure code set. */
export const WORKER_FAILURE_CODES = [
  /** Dispatch after shutdown began — new inspection work is rejected (ADR-0005 normal stop). */
  'shutdown',
  /** The request is not one of the four typed inspection requests. */
  'malformed-request',
  /** An inspection branch failed: an AdapterError (with its code/details) or an unexpected error (generic). */
  'inspection-failed',
  /** The styles inspection completed unconverged — a classified mismatch or an invalidation race (E3). */
  'inspection-unconverged',
] as const;

export type WorkerFailureCode = (typeof WORKER_FAILURE_CODES)[number];

/** One worker failure — the structured rejection a dispatch settles with. */
export type WorkerFailure =
  | { readonly code: 'shutdown'; readonly message: string }
  | { readonly code: 'malformed-request'; readonly message: string }
  | {
      readonly code: 'inspection-failed';
      readonly message: string;
      /** The adapter's closed failure code when the branch rejected with one; null for unexpected errors. */
      readonly adapterCode: AdapterErrorCode | null;
      /** The adapter's sanitized detail payload (version pairs, seam shapes — sanctioned carriers). */
      readonly details?: AdapterErrorDetails;
    }
  | {
      readonly code: 'inspection-unconverged';
      readonly message: string;
      /** Which unfinished outcome the styles inspection ended on (E3). */
      readonly outcome: Exclude<StylesInspectionOutcome, { outcome: 'converged' }>['outcome'];
      /** The parity mismatch category when the outcome is a mismatch; null for a raced pass. */
      readonly category: string | null;
    };

/** The rejection dispatch settles with — the typed failure riding a standard Error. */
export class WorkerRejectionError extends Error {
  readonly failure: WorkerFailure;

  constructor(failure: WorkerFailure) {
    super(failure.message);
    this.name = 'WorkerRejectionError';
    this.failure = failure;
  }
}

/** Dispatch after shutdown began: new work never reaches a branch. */
export function shutdownFailure(): WorkerFailure {
  return {
    code: 'shutdown',
    message: 'the project plane worker is shutting down and rejects new inspection work',
  };
}

/** A request outside the four typed families (or over-carrying fields). */
export function malformedRequestFailure(): WorkerFailure {
  return {
    code: 'malformed-request',
    message:
      'the request is not one of the typed project, content, routes, or styles inspection requests',
  };
}

/**
 * Maps one branch failure to the structured worker failure: an
 * `AdapterError` keeps its closed code and sanitized details; anything
 * else becomes the generic unexpected failure — its message is NEVER
 * forwarded (an unexpected error's text is untrusted free text).
 */
export function branchFailure(family: InspectionFamily, error: unknown): WorkerFailure {
  if (error instanceof AdapterError) {
    return {
      code: 'inspection-failed',
      message: `the ${family} inspection failed at the project adapter (${error.code})`,
      adapterCode: error.code,
      details: error.details,
    };
  }
  return {
    code: 'inspection-failed',
    message: `the ${family} inspection failed unexpectedly`,
    adapterCode: null,
  };
}

/** The unconverged styles outcome (mismatch or race) as a structured failure — never a payload. */
export function unconvergedFailure(
  outcome: Exclude<StylesInspectionOutcome, { outcome: 'converged' }>,
): WorkerFailure {
  return outcome.outcome === 'mismatch'
    ? {
        code: 'inspection-unconverged',
        message: `the styles inspection did not converge (parity mismatch: ${outcome.mismatch.category})`,
        outcome: 'mismatch',
        category: outcome.mismatch.category,
      }
    : {
        code: 'inspection-unconverged',
        message: 'the styles inspection did not converge (it raced a watcher invalidation)',
        outcome: 'raced',
        category: null,
      };
}

/** The error-level diagnostic for one branch failure (the message is already closed-template). */
export function branchFailureDiagnostic(failure: WorkerFailure): WorkerDiagnosticEvent {
  return { type: 'diagnostic', level: 'error', message: failure.message };
}

/** The warn-level diagnostic for one unconverged styles outcome — retryable by a later inspection. */
export function unconvergedDiagnostic(failure: WorkerFailure): WorkerDiagnosticEvent {
  return { type: 'diagnostic', level: 'warn', message: failure.message };
}

/** The error-level diagnostic for one cleanup failure at stop. */
export function cleanupDiagnostic(category: string): WorkerDiagnosticEvent {
  return {
    type: 'diagnostic',
    level: 'error',
    message: `project plane cleanup failed (${category})`,
  };
}
