import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';

/**
 * The private main↔control-plane-child channel vocabulary (#243, H1):
 * everything that crosses the private IPC channel AFTER the one-use boot
 * capability (D3 #222 — the capability is the channel's first message and
 * the boot seam's own contract, never re-invented here).
 *
 * The channel is the same kernel-exclusive pipe the capability rode: no
 * HTTP, WebSocket, or URL surface, and no authorization material ever
 * travels through it (paths are not authority — the registry-writer lease
 * and the boot capability are, and neither appears in these messages).
 *
 * What H1's child actually serves: the native directory grant's registry
 * validation (`register-root`) and the settled-transition delegation
 * surface (`activate`/`deactivate`). The child's composed surface for H1
 * is the private boot + kernel lease + production registry — the
 * origin/HTTP/SSE/supervisor composition lands with its owning lanes
 * (the web host #240 remains the behavioral host), so transitions answer
 * the honest typed refusal until then. Every report is sanitized: the
 * register result carries the wire-safe project summary shape — key,
 * display name, availability — never a filesystem root, even though the
 * receiving end is trusted main (minimum disclosure, ADR-0006 §1).
 */

const CHANNEL_TAG = 'astroix.desktop-private-channel';

/** The sanitized project summary the register result carries — the registry's wire shape, never a root. */
export interface GrantedProjectSummary {
  readonly projectKey: string;
  readonly displayName: string;
  readonly availability: 'available' | 'unavailable';
}

/** Why a native directory grant was refused — the registry's closed code set plus the child's own refusal. */
export type RegisterRefusalCode =
  | 'root-unavailable'
  | 'quarantined'
  | 'control-plane-unavailable'
  | 'invalid-request';

/** One register-root reply: the sanitized summary, or the sanitized refusal. */
export type RegisterResult =
  | { readonly ok: true; readonly summary: GrantedProjectSummary }
  | { readonly ok: false; readonly code: RegisterRefusalCode };

/** Why a delegated session transition was refused — sanitized vocabulary only. */
export type TransitionRefusalCode =
  | 'unavailable-composition'
  | 'no-active-session'
  | 'stale-session'
  | 'concurrent-activation'
  | 'control-plane-unavailable';

/** One activate/deactivate reply: the session the child reports after the attempt, or the refusal. */
export type TransitionOutcome =
  | { readonly kind: 'completed'; readonly sessionRef: SessionRef | null }
  | { readonly kind: 'refused'; readonly reason: TransitionRefusalCode };

/** The closed main→child request union. */
export type DesktopChildRequest =
  | {
      readonly astroix: typeof CHANNEL_TAG;
      readonly kind: 'register-root';
      readonly requestId: number;
      readonly root: string;
    }
  | {
      readonly astroix: typeof CHANNEL_TAG;
      readonly kind: 'activate';
      readonly requestId: number;
      readonly projectKey: string;
    }
  | {
      readonly astroix: typeof CHANNEL_TAG;
      readonly kind: 'deactivate';
      readonly requestId: number;
      readonly sessionRef: SessionRef;
    };

/** The closed child→main report union. */
export type DesktopChildReport =
  | { readonly astroix: typeof CHANNEL_TAG; readonly kind: 'booted' }
  | {
      readonly astroix: typeof CHANNEL_TAG;
      readonly kind: 'register-result';
      readonly requestId: number;
      readonly result: RegisterResult;
    }
  | {
      readonly astroix: typeof CHANNEL_TAG;
      readonly kind: 'transition-result';
      readonly requestId: number;
      readonly outcome: TransitionOutcome;
    }
  | {
      readonly astroix: typeof CHANNEL_TAG;
      readonly kind: 'session-state';
      readonly sessionRef: SessionRef | null;
    };

function isOwnMessage(message: unknown): message is Record<string, unknown> {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as Record<string, unknown>).astroix === CHANNEL_TAG
  );
}

/**
 * The top-level key fence: a message carrying any field the closed shape
 * does not name is drifted — dropped, never parsed (the fail-closed law
 * applies to the whole envelope, not just the nested result shapes).
 */
function hasExactKeys(message: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(message);
  return present.length === keys.length && keys.every((key) => key in message);
}

function isSessionRef(value: unknown): value is SessionRef {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.runtimeEpoch === 'string' &&
    record.runtimeEpoch.length > 0 &&
    typeof record.generation === 'number' &&
    Number.isInteger(record.generation) &&
    record.generation >= 1
  );
}

function isRegisterResult(value: unknown): value is RegisterResult {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === true) {
    const summary = record.summary;
    if (typeof summary !== 'object' || summary === null) return false;
    const s = summary as Record<string, unknown>;
    return (
      typeof s.projectKey === 'string' &&
      s.projectKey.length > 0 &&
      typeof s.displayName === 'string' &&
      (s.availability === 'available' || s.availability === 'unavailable')
    );
  }
  if (record.ok === false) {
    return (
      typeof record.code === 'string' &&
      ['root-unavailable', 'quarantined', 'control-plane-unavailable', 'invalid-request'].includes(
        record.code,
      )
    );
  }
  return false;
}

function isTransitionOutcome(value: unknown): value is TransitionOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === 'completed') {
    return record.sessionRef === null || isSessionRef(record.sessionRef);
  }
  if (record.kind === 'refused') {
    return (
      typeof record.reason === 'string' &&
      [
        'unavailable-composition',
        'no-active-session',
        'stale-session',
        'concurrent-activation',
        'control-plane-unavailable',
      ].includes(record.reason)
    );
  }
  return false;
}

function isRequestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * Lifts one unknown channel message into a main→child request. Unknown
 * fields, wrong tags, and malformed shapes reject as `null` — a drifted
 * or hostile message is dropped, never heuristically parsed (the
 * fail-closed law).
 */
export function parseDesktopChildRequest(message: unknown): DesktopChildRequest | null {
  if (!isOwnMessage(message)) return null;
  const kind = message.kind;
  if (!isRequestId(message.requestId)) return null;
  if (
    kind === 'register-root' &&
    hasExactKeys(message, ['astroix', 'kind', 'requestId', 'root']) &&
    typeof message.root === 'string' &&
    message.root.length > 0
  ) {
    return {
      astroix: CHANNEL_TAG,
      kind: 'register-root',
      requestId: message.requestId,
      root: message.root,
    };
  }
  if (
    kind === 'activate' &&
    hasExactKeys(message, ['astroix', 'kind', 'requestId', 'projectKey']) &&
    typeof message.projectKey === 'string' &&
    message.projectKey.length > 0
  ) {
    return {
      astroix: CHANNEL_TAG,
      kind: 'activate',
      requestId: message.requestId,
      projectKey: message.projectKey,
    };
  }
  if (
    kind === 'deactivate' &&
    hasExactKeys(message, ['astroix', 'kind', 'requestId', 'sessionRef']) &&
    isSessionRef(message.sessionRef)
  ) {
    return {
      astroix: CHANNEL_TAG,
      kind: 'deactivate',
      requestId: message.requestId,
      sessionRef: message.sessionRef,
    };
  }
  return null;
}

/**
 * Lifts one unknown channel message into a child→main report. The same
 * closed-vocabulary discipline as the request parse: `null` for anything
 * the child never said.
 */
export function parseDesktopChildReport(message: unknown): DesktopChildReport | null {
  if (!isOwnMessage(message)) return null;
  const kind = message.kind;
  if (kind === 'booted' && hasExactKeys(message, ['astroix', 'kind'])) {
    return { astroix: CHANNEL_TAG, kind: 'booted' };
  }
  if (kind === 'session-state' && hasExactKeys(message, ['astroix', 'kind', 'sessionRef'])) {
    const ref = message.sessionRef;
    if (ref === null || isSessionRef(ref)) {
      return { astroix: CHANNEL_TAG, kind: 'session-state', sessionRef: ref };
    }
    return null;
  }
  if (!isRequestId(message.requestId)) return null;
  if (
    kind === 'register-result' &&
    hasExactKeys(message, ['astroix', 'kind', 'requestId', 'result']) &&
    isRegisterResult(message.result)
  ) {
    return {
      astroix: CHANNEL_TAG,
      kind: 'register-result',
      requestId: message.requestId,
      result: message.result,
    };
  }
  if (
    kind === 'transition-result' &&
    hasExactKeys(message, ['astroix', 'kind', 'requestId', 'outcome']) &&
    isTransitionOutcome(message.outcome)
  ) {
    return {
      astroix: CHANNEL_TAG,
      kind: 'transition-result',
      requestId: message.requestId,
      outcome: message.outcome,
    };
  }
  return null;
}

/** Builds a register-root request (main side). */
export function registerRootRequest(requestId: number, root: string): DesktopChildRequest {
  return { astroix: CHANNEL_TAG, kind: 'register-root', requestId, root };
}

/** Builds an activate request (main side). */
export function activateRequest(requestId: number, projectKey: string): DesktopChildRequest {
  return { astroix: CHANNEL_TAG, kind: 'activate', requestId, projectKey };
}

/** Builds a deactivate request (main side). */
export function deactivateRequest(requestId: number, sessionRef: SessionRef): DesktopChildRequest {
  return { astroix: CHANNEL_TAG, kind: 'deactivate', requestId, sessionRef };
}

/** Builds the booted report (child side). */
export function bootedReport(): DesktopChildReport {
  return { astroix: CHANNEL_TAG, kind: 'booted' };
}

/** Builds a register result (child side). */
export function registerResultReport(
  requestId: number,
  result: RegisterResult,
): DesktopChildReport {
  return { astroix: CHANNEL_TAG, kind: 'register-result', requestId, result };
}

/** Builds a transition outcome (child side). */
export function transitionResultReport(
  requestId: number,
  outcome: TransitionOutcome,
): DesktopChildReport {
  return { astroix: CHANNEL_TAG, kind: 'transition-result', requestId, outcome };
}
