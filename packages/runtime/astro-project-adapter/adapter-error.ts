import { findDisclosure } from '@wojciechpiskorz/astroix-protocol';

/**
 * The AstroProjectAdapter's closed error surface (ADR-0005 compatibility
 * contract, #225): every adapter failure carries a code from this set, a
 * sanitized message, and code-specific structured details. The adapter is
 * the internal seam behind which all version-sensitive behavior lives —
 * it never guesses, and when it rejects, the diagnostic names the seam or
 * contract that failed and nothing else.
 *
 * Sanitization follows the protocol's output-hygiene doctrine
 * (`packages/protocol/src/sanitization.ts`, ADR-0006 §7 / ADR-0007):
 * adapter messages never disclose roots, ports, PIDs, environment values,
 * or stacks. The guard is enforced at construction — a message that would
 * leak cannot exist as an AdapterError — because these diagnostics are
 * the raw material later lanes lift onto the wire; what must not exist
 * downstream must not exist here either. Structured `details` fields are
 * the sanctioned carriers for facts a diagnostic needs (version strings,
 * seam names, shape descriptions).
 */

/** The closed adapter failure code set. */
export const ADAPTER_ERROR_CODES = [
  /** The managed project's installed Astro/Vite pair is not certified (#206, ADR-0005). */
  'uncertified-pair',
  /** Astro or Vite could not be resolved from the managed project's installation. */
  'dependency-unresolved',
  /** A named seam's observed shape differs from the certified shape — fail closed, never guess. */
  'seam-rejected',
  /** A fresh module runner left transport or graph residue after close (#206 runner discipline). */
  'runner-cleanup',
] as const;

export type AdapterErrorCode = (typeof ADAPTER_ERROR_CODES)[number];

/** The seam classes of `docs/core-reuse.md` — the compatibility contract a seam carries. */
export const SEAM_CLASSES = ['public', 'certified exact-pair', 'fail-closed private'] as const;

export type SeamClass = (typeof SEAM_CLASSES)[number];

/** Per-code detail payloads — closed shapes, sanitized facts only (no paths, no raw dumps). */
export type AdapterErrorDetails =
  | { detected: ExactPairValue; certified: readonly ExactPairValue[]; rejectedContract: string }
  | { dependency: 'astro' | 'vite'; reason: 'not-resolvable' | 'versionless-manifest' }
  | { seam: string; seamClass: SeamClass; expected: string; observed: string }
  | { residue: 'send-listeners' | 'open-runner'; before?: number; after?: number };

/** The version-pair value shared by the pair modules (shape only; the type lives here once). */
export interface ExactPairValue {
  readonly astro: string;
  readonly vite: string;
}

/**
 * The adapter's failure type. `cause` keeps the upstream system error for
 * the project plane's own logs; the message and details stay clean.
 */
export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly details: AdapterErrorDetails;

  constructor(
    code: AdapterErrorCode,
    message: string,
    details: AdapterErrorDetails,
    options?: { cause?: unknown },
  ) {
    const disclosure = findDisclosure(message);
    if (disclosure !== null) {
      // Fail closed on the diagnostic itself: a leaky message is replaced
      // by the finding, never emitted (the leak is a programming error in
      // the adapter, not information a consumer needs).
      throw new Error(
        `adapter diagnostic for ${code} refused: message may not disclose ${disclosure.what}`,
        { cause: options?.cause },
      );
    }
    super(message, options);
    this.name = 'AdapterError';
    this.code = code;
    this.details = details;
  }
}

/**
 * The seam-rejection construction, single-homed (#311, hoisted from the
 * per-lane copies of #225/#228/#229): the sanitized message template
 * stated exactly once for every seam the adapter probes — seam, expected
 * shape, observed description — with the seam's class and the mismatch
 * riding in the code-specific details, and the upstream cause kept when
 * there is one. A lane probing a new seam rejects through this and
 * nothing else, so the format can never drift between surfaces.
 */
export function seamRejection(
  seam: string,
  seamClass: SeamClass,
  expected: string,
  observed: string,
  cause?: unknown,
): AdapterError {
  const details: AdapterErrorDetails = { seam, seamClass, expected, observed };
  const message = `AstroProjectAdapter seam rejection at ${seam}: expected ${expected}; observed ${observed}`;
  // The options object rides only when a cause exists — installing an
  // undefined `cause` key is observable (`'cause' in error`), and the
  // no-cause construction sites never passed options.
  return cause === undefined
    ? new AdapterError('seam-rejected', message, details)
    : new AdapterError('seam-rejected', message, details, { cause });
}

/** A structural observed-shape description for seam rejections — type facts, never values. */
export function observedShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  if (type !== 'object' && type !== 'function') return `typeof ${type}`;
  const keys = Object.keys(value as Record<string, unknown>);
  const missing =
    keys.length === 0 ? 'no own properties' : `own properties ${keys.slice(0, 5).join(', ')}`;
  return `${type} with ${missing}`;
}
