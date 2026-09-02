/**
 * The single statement of every protocol v1 limit, deadline, and entropy
 * size. Each value cites the ruling ADR paragraph that fixed it — a number
 * here without a citation is a defect, and a change here without an ADR
 * ruling behind it is out of scope (the ADRs are the authority, #220).
 *
 * Sources: ADR-0006 §7 ("Initial hard limits": the five byte caps and the
 * two SSE client-role counts), §4 (the 5 s drain and 2 s forced-reap
 * deadlines), §8 ("Lifecycle limits": 30 s startup, 5 s graceful stop),
 * §1 (128-bit ProjectKey), §3 (256-bit request capability). Enforcing the
 * limits is the transport's job (packages/runtime, a later lane); this
 * module is the one place the numbers live.
 */
export const LIMITS = {
  /**
   * 64 KiB registry/lifecycle JSON (ADR-0006 §7) — the cap on lifecycle
   * envelopes (`list-projects`, `activate`, `deactivate`) and registry reads.
   */
  lifecycleJsonBytes: 64 * 1024,
  /**
   * 8 MiB per edit request (ADR-0006 §7) — the cap on an `apply-edit`
   * envelope as a whole.
   */
  editRequestBytes: 8 * 1024 * 1024,
  /**
   * 8 MiB per editable text resource (ADR-0006 §7) — the cap on the
   * contents of any one editable text resource carried in a write plan.
   */
  editableResourceBytes: 8 * 1024 * 1024,
  /** 32 MiB per inspection response (ADR-0006 §7); list/inspection APIs paginate before it. */
  inspectionResponseBytes: 32 * 1024 * 1024,
  /** 256 KiB per SSE event (ADR-0006 §7). */
  sseEventBytes: 256 * 1024,
  /** 16 KiB public error details (ADR-0006 §7) — the `details` budget of an error envelope. */
  errorDetailsBytes: 16 * 1024,
  /** One authoritative SSE client (ADR-0006 §7) — the single editor stream. */
  authoritativeSseClients: 1,
  /** Up to three read-only diagnostics clients (ADR-0006 §7). */
  diagnosticSseClients: 3,
  /** Candidate startup deadline: 30 s (ADR-0006 §8). */
  startupDeadlineMs: 30_000,
  /** Graceful project stop after authority revocation: 5 s (ADR-0006 §8). */
  gracefulStopDeadlineMs: 5_000,
  /** Forced termination reap deadline: 2 s (ADR-0006 §4 step 4; §8 "forced termination reap: 2 s"). */
  forcedReapDeadlineMs: 2_000,
  /**
   * Drain deadline: wait up to 5 s for every accepted operation to reach a
   * terminal result (ADR-0006 §4 step 2 "wait up to 5 seconds").
   */
  drainDeadlineMs: 5_000,
  /** ProjectKey entropy: a random 128-bit value, lowercase Base32 (ADR-0006 §1). */
  projectKeyBits: 128,
  /**
   * Request-authority capability: a random 256-bit value (ADR-0006 §3).
   * Size is recorded for the control plane's generator only — a capability
   * never appears in a URL, JSON body, event, log, or JavaScript value, so
   * no wire schema carries one.
   */
  requestCapabilityBits: 256,
} as const;

/** Every key of {@link LIMITS} that names a byte budget. */
export type ByteLimitName =
  | 'lifecycleJsonBytes'
  | 'editRequestBytes'
  | 'editableResourceBytes'
  | 'inspectionResponseBytes'
  | 'sseEventBytes'
  | 'errorDetailsBytes';

const encoder = new TextEncoder();

/**
 * UTF-8 byte size of a string — the unit every byte limit counts in. A
 * JS string's `.length` counts UTF-16 code units and would under-count
 * multi-byte content against the ADR caps.
 */
export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * UTF-8 byte size of a JSON-serialized value — the unit every envelope
 * limit counts in. Envelope caps are stated over the wire bytes, not the
 * in-memory shape.
 */
export function envelopeBytes(value: unknown): number {
  return byteLength(JSON.stringify(value));
}

/** Whether `text` fits the named byte limit (inclusive at the boundary). */
export function withinByteLimit(text: string, limit: ByteLimitName): boolean {
  return byteLength(text) <= LIMITS[limit];
}
