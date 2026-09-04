import type { ResourceGrant } from '@wojciechpiskorz/astroix-protocol';
import { AppClientError } from '../../app-client.ts';
import { StaleSessionResultError } from '../../query/gated-session-fetch.ts';

/**
 * The shared edit drain/fence seam's write-loop machine (ADR-0002
 * amendment 5, born at its second consumer #250/I2; generalized
 * verbatim from the Content vertical's landed loop #253/J3 — the
 * mechanical half, domain-deaf by construction): the AppClient's five
 * reported states — `pending`, `committed`, `rejected`,
 * `irreversible-postcommit`, `refresh-required` — as one pure reducer
 * over dispatch-sequenced events, plus the sanitized classification of
 * everything a mutation can settle with. Every feature write loop
 * (Content's serializer, CSS's splice planner) dispatches through this
 * machine; what stays feature-local is the plan's own serialization
 * and the landing's freshness predicates.
 *
 * The two laws this machine holds:
 *
 * - **A stale response never overwrites a committed result**: every
 *   settle carries the dispatch sequence it belongs to, and an event
 *   whose sequence is not the live one is dropped — the response of an
 *   older dispatch (or one arriving after the loop reset) cannot move
 *   the state a newer settlement already owns.
 * - **Uncertainty is reported, never guessed**: a mutation that crossed
 *   the wire and settled without a protocol answer — transport failure,
 *   the closed `internal-error`, an abort, the stale-response belt — is
 *   `irreversible-postcommit` (the write may or may not have landed);
 *   the refresh that follows is the only honest convergence, and its
 *   awaiting state (`refresh-required`) is distinct from a confirmed
 *   `committed` one.
 */

/** The AC's five reported states, plus the quiet `idle`. */
export type WritePhase =
  | 'idle'
  | 'pending'
  | 'committed'
  | 'rejected'
  | 'irreversible-postcommit'
  | 'refresh-required';

/** The machine's state — one dispatch's truth. */
export interface WriteLoopState {
  readonly phase: WritePhase;
  /** The dispatch this state describes; 0 is "no dispatch ever". */
  readonly seq: number;
  /** The settled server revision (`committed`) — the write-loop's ordering currency. */
  readonly revision: number | null;
  /** The rejection's sanitized code (`rejected`) — client or protocol vocabulary. */
  readonly code: string | null;
  /** The revision-conflict handback: the current SHA the next attempt serializes against. */
  readonly conflictSha256: string | null;
}

/** The quiet initial state. */
export const IDLE_WRITE: WriteLoopState = {
  phase: 'idle',
  seq: 0,
  revision: null,
  code: null,
  conflictSha256: null,
};

/** The machine's events — every settlement carries its dispatch sequence. */
export type WriteLoopEvent =
  | { readonly type: 'submitted'; readonly seq: number }
  | { readonly type: 'committed'; readonly seq: number; readonly revision: number }
  | { readonly type: 'uncertain'; readonly seq: number }
  | { readonly type: 'rejected'; readonly seq: number; readonly code: string }
  | { readonly type: 'conflict'; readonly seq: number; readonly currentSha256: string }
  | { readonly type: 'refresh-begun'; readonly seq: number }
  | { readonly type: 'refresh-landed'; readonly seq: number }
  | { readonly type: 'reset' };

/**
 * One transition — the sequence guard first: only the live dispatch's
 * events move the machine (`reset` is unconditional). The phase lattice:
 *
 * - `submitted` → `pending` (a fresh sequence only).
 * - `committed` → the server confirmed the write at its revision.
 * - `uncertain` → the outcome is unknowable from the response.
 * - `rejected` / `conflict` → the server (or the client's prechecks)
 *   refused without writing; the conflict carries the disk-truth SHA.
 * - `refresh-begun` → the post-settlement refresh is now outstanding
 *   (legal from `committed` and `irreversible-postcommit`).
 * - `refresh-landed` → revisioned server truth arrived → `idle`.
 * - `reset` → `idle` (binding change, session teardown).
 */
export function reduceWrite(state: WriteLoopState, event: WriteLoopEvent): WriteLoopState {
  if (event.type === 'reset') return IDLE_WRITE;
  // `submitted` mints the live sequence — legal only from the quiet
  // state and only FORWARD (the mint is monotonic for the store's whole
  // lifetime, so a post-reset dispatch can never collide with a
  // pre-reset one's stale settles).
  if (event.type === 'submitted') {
    return state.phase === 'idle' && event.seq > state.seq ? pendingState(event.seq) : state;
  }
  // The stale-settle law: an event for a dispatch that is not the live
  // one never applies — including every event after a reset (seq 0 only
  // accepts a fresh `submitted`).
  if (event.seq !== state.seq) return state;
  // The four settlements are one lattice edge (pending → settled); the
  // two refresh edges are their own legality windows.
  if (event.type === 'refresh-begun') {
    return state.phase === 'committed' || state.phase === 'irreversible-postcommit'
      ? { ...state, phase: 'refresh-required' }
      : state;
  }
  if (event.type === 'refresh-landed') {
    return state.phase === 'refresh-required' ? IDLE_WRITE : state;
  }
  return state.phase === 'pending' ? settledState(event) : state;
}

/** The pending state one fresh dispatch opens. */
function pendingState(seq: number): WriteLoopState {
  return { phase: 'pending', seq, revision: null, code: null, conflictSha256: null };
}

/** The settled state one terminal event closes a pending dispatch with. */
function settledState(
  event: Extract<WriteLoopEvent, { type: 'committed' | 'uncertain' | 'rejected' | 'conflict' }>,
): WriteLoopState {
  if (event.type === 'committed') {
    return {
      phase: 'committed',
      seq: event.seq,
      revision: event.revision,
      code: null,
      conflictSha256: null,
    };
  }
  if (event.type === 'uncertain') {
    return {
      phase: 'irreversible-postcommit',
      seq: event.seq,
      revision: null,
      code: null,
      conflictSha256: null,
    };
  }
  if (event.type === 'rejected') {
    return {
      phase: 'rejected',
      seq: event.seq,
      revision: null,
      code: event.code,
      conflictSha256: null,
    };
  }
  return {
    phase: 'rejected',
    seq: event.seq,
    revision: null,
    code: 'revision-conflict',
    conflictSha256: event.currentSha256,
  };
}

/** How one mutation settled — the sanitized classification. */
export type SettleClassification =
  | {
      readonly kind: 'committed';
      readonly revision: number;
      /**
       * The follow-on grant VERBATIM — the whole claim, `null` when the
       * server renewed none: a consumer that anchors its next edit on
       * the renewal (the CSS loop's anchor grant) needs every field,
       * not just the token it echoes into the session's accounting.
       */
      readonly nextGrant: ResourceGrant | null;
    }
  | { readonly kind: 'rejected'; readonly code: string }
  | { readonly kind: 'conflict'; readonly code: string; readonly currentSha256: string }
  | { readonly kind: 'uncertain'; readonly code: string };

/** The server codes that are honest refusals — a mutation that did not write. */
const REFUSAL_CODES = new Set([
  'grant-rejected',
  'stale-session',
  'unauthorized',
  'malformed-request',
  'resource-not-found',
  'concurrent-activation',
  'unsupported-protocol-version',
  'payload-too-large',
]);

/**
 * Classifies one settle: a successful `EditResult`, or an error the
 * AppClient sanitized. `internal-error` and every transport shape are
 * UNCERTAIN for a mutation — the write crossed the wire, and the
 * response cannot prove it did not land; the refresh converges.
 */
export function classifySettle(
  outcome: { revision: number; nextGrant?: ResourceGrant } | Error,
): SettleClassification {
  if (!(outcome instanceof Error)) {
    return {
      kind: 'committed',
      revision: outcome.revision,
      nextGrant: outcome.nextGrant ?? null,
    };
  }
  if (outcome instanceof StaleSessionResultError) {
    // The belt tripped: the session moved before the response arrived —
    // the write's fate is exactly the unknowable case.
    return { kind: 'uncertain', code: 'stale-response' };
  }
  if (outcome instanceof AppClientError) {
    if (outcome.kind === 'transport') return { kind: 'uncertain', code: 'transport' };
    const envelope = outcome.envelope;
    if (envelope === undefined) return { kind: 'uncertain', code: 'internal-error' };
    const code = envelope.error.code;
    if (code === 'revision-conflict') {
      const current = (envelope.error.details as { currentSha256?: string } | undefined)
        ?.currentSha256;
      return typeof current === 'string'
        ? { kind: 'conflict', code, currentSha256: current }
        : { kind: 'rejected', code };
    }
    if (REFUSAL_CODES.has(code)) return { kind: 'rejected', code };
    return { kind: 'uncertain', code: code ?? 'internal-error' };
  }
  if (outcome instanceof Error && outcome.name === 'AbortError') {
    return { kind: 'uncertain', code: 'aborted' };
  }
  return { kind: 'uncertain', code: 'unknown' };
}
