import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';

/**
 * The private main↔control-plane-child channel vocabulary (#243, H1;
 * #362, H7's composition extension): everything that crosses the
 * private IPC channel AFTER the one-use boot capability (D3 #222 — the
 * capability is the channel's first message and the boot seam's own
 * contract, never re-invented here).
 *
 * The channel is the same kernel-exclusive pipe the capability rode: no
 * HTTP, WebSocket, or URL surface, and no authorization material ever
 * travels through it (paths are not authority — the registry-writer
 * lease and the boot capability are, and neither appears in these
 * messages).
 *
 * What the child serves: the native directory grant's registry
 * validation (`register-root`) and the settled-transition delegation
 * (`activate`/`deactivate`) — since H7 (#362) driven by the REAL
 * control-plane composition booted inside the child (the shared seam
 * the web host consumes), so transitions answer the settled outcome
 * vocabulary, never the retired `unavailable-composition` refusal. The
 * composition's host observations ride the same channel: the child
 * asks, main observes the authoritative window and answers, and the
 * live document capability flows back for the H4 injection. Every
 * report is sanitized: the register result carries the wire-safe
 * project summary shape — key, display name, availability — never a
 * filesystem root, even though the receiving end is trusted main
 * (minimum disclosure, ADR-0006 §1).
 */

const CHANNEL_TAG = 'astroix.desktop-private-channel';

/** The sanitized project summary the register result carries — the registry's wire shape, never a root. */
export interface GrantedProjectSummary {
  readonly projectKey: string;
  readonly displayName: string;
  readonly availability: 'available' | 'unavailable';
}

/**
 * Why a native directory grant was refused — the registry's closed code set
 * plus the child's own refusal. Derived from the one `as const` array so the
 * union and the runtime membership check below can never drift apart
 * (the executor-ipc idiom).
 */
const REGISTER_REFUSAL_CODES = [
  'root-unavailable',
  'quarantined',
  'control-plane-unavailable',
  'invalid-request',
] as const;

export type RegisterRefusalCode = (typeof REGISTER_REFUSAL_CODES)[number];

/** One register-root reply: the sanitized summary, or the sanitized refusal. */
export type RegisterResult =
  | { readonly ok: true; readonly summary: GrantedProjectSummary }
  | { readonly ok: false; readonly code: RegisterRefusalCode };

/**
 * Why a delegated session transition was refused — sanitized vocabulary
 * only, derived from the one `as const` array (same drift-proof idiom as
 * the register codes). The H1-era `unavailable-composition` code was
 * RETIRED at H7 (#362): the composition is booted, and the vocabulary
 * no longer names a seam that does not exist.
 */
const TRANSITION_REFUSAL_CODES = [
  'no-active-session',
  'stale-session',
  'concurrent-activation',
  'transition-failed',
  'control-plane-unavailable',
] as const;

export type TransitionRefusalCode = (typeof TRANSITION_REFUSAL_CODES)[number];

/** One activate/deactivate reply: the session the child reports after the attempt, or the refusal. */
export type TransitionOutcome =
  | { readonly kind: 'completed'; readonly sessionRef: SessionRef | null }
  | { readonly kind: 'refused'; readonly reason: TransitionRefusalCode };

/**
 * One host-observed document identity — the authoritative window's
 * opaque `webContents` id and its observed top-level navigation (H4's
 * law: a bind names an observed navigation, never a predicted one).
 */
export interface HostDocumentIdentityReport {
  readonly webContentsId: number;
  readonly navigationId: number;
}

/**
 * One main-side authority observation forwarded into the composition's
 * document authority — the mirror-side invalidations (H4's port driven
 * over the private channel): navigations, renderer loss, target
 * destruction, and the guarded target's fail-closed revocations.
 */
export type AuthorityObservation =
  | {
      readonly kind: 'document-navigated';
      readonly webContentsId: number;
      readonly navigationId: number;
    }
  | { readonly kind: 'renderer-lost'; readonly webContentsId: number }
  | { readonly kind: 'target-destroyed'; readonly webContentsId: number }
  | { readonly kind: 'revoked'; readonly capability: string };

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
    }
  | {
      readonly astroix: typeof CHANNEL_TAG;
      readonly kind: 'host-observation-result';
      readonly requestId: number;
      readonly observed: true;
      readonly document: HostDocumentIdentityReport;
    }
  | {
      readonly astroix: typeof CHANNEL_TAG;
      readonly kind: 'host-observation-result';
      readonly requestId: number;
      readonly observed: false;
      readonly document: null;
    }
  | {
      readonly astroix: typeof CHANNEL_TAG;
      readonly kind: 'authority-observation';
      readonly requestId: number;
      readonly observation: AuthorityObservation;
    };

/** The closed child→main report union. */
export type DesktopChildReport =
  | { readonly astroix: typeof CHANNEL_TAG; readonly kind: 'booted'; readonly port: number }
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
    }
  | {
      readonly astroix: typeof CHANNEL_TAG;
      readonly kind: 'observe-document';
      readonly requestId: number;
    }
  | {
      readonly astroix: typeof CHANNEL_TAG;
      readonly kind: 'replace-top-level';
      readonly requestId: number;
      readonly sessionRef: SessionRef;
      readonly projectKey: string;
      readonly origin: string;
    }
  | {
      readonly astroix: typeof CHANNEL_TAG;
      readonly kind: 'authority-observation-result';
      readonly requestId: number;
    }
  | {
      readonly astroix: typeof CHANNEL_TAG;
      readonly kind: 'document-capability';
      readonly webContentsId: number;
      readonly capability: string | null;
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
      (REGISTER_REFUSAL_CODES as readonly string[]).includes(record.code)
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
      (TRANSITION_REFUSAL_CODES as readonly string[]).includes(record.reason)
    );
  }
  return false;
}

function isRequestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** A TCP port the composition's listener may report (1–65535, integral). */
function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** An opaque host `webContents` identity — a positive integer the host minted. */
function isWebContentsId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** A capability the composition minted — non-empty opaque string. */
function isCapability(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** The observation union's per-kind validator — one closed key set per branch, never a merge. */
function isAuthorityObservation(value: unknown): value is AuthorityObservation {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === 'document-navigated') {
    return (
      isWebContentsId(record.webContentsId) &&
      Number.isInteger(record.navigationId) &&
      (record.navigationId as number) >= 1
    );
  }
  if (record.kind === 'renderer-lost' || record.kind === 'target-destroyed') {
    return isWebContentsId(record.webContentsId);
  }
  if (record.kind === 'revoked') {
    return isCapability(record.capability);
  }
  return false;
}

/**
 * Lifts one unknown channel message into a main→child request. Unknown
 * fields, wrong tags, and malformed shapes reject as `null` — a drifted
 * or hostile message is dropped, never heuristically parsed (the
 * fail-closed law).
 */
export function parseDesktopChildRequest(message: unknown): DesktopChildRequest | null {
  if (!isOwnMessage(message)) return null;
  return (
    liftRegisterRootRequest(message) ??
    liftActivateRequest(message) ??
    liftDeactivateRequest(message) ??
    liftHostObservationResultRequest(message) ??
    liftAuthorityObservationRequest(message)
  );
}

function liftRegisterRootRequest(message: Record<string, unknown>): DesktopChildRequest | null {
  if (
    message.kind === 'register-root' &&
    isRequestId(message.requestId) &&
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
  return null;
}

function liftActivateRequest(message: Record<string, unknown>): DesktopChildRequest | null {
  if (
    message.kind === 'activate' &&
    isRequestId(message.requestId) &&
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
  return null;
}

function liftDeactivateRequest(message: Record<string, unknown>): DesktopChildRequest | null {
  if (
    message.kind === 'deactivate' &&
    isRequestId(message.requestId) &&
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

function liftHostObservationResultRequest(
  message: Record<string, unknown>,
): DesktopChildRequest | null {
  if (
    message.kind !== 'host-observation-result' ||
    !isRequestId(message.requestId) ||
    !hasExactKeys(message, ['astroix', 'kind', 'requestId', 'observed', 'document'])
  ) {
    return null;
  }
  if (message.observed !== true && message.observed !== false) return null;
  if (message.observed === false) {
    // The unobserved branch carries an explicit null document — the key
    // fence stays exact per branch, never a silently ignored field.
    if (message.document !== null) return null;
    return {
      astroix: CHANNEL_TAG,
      kind: 'host-observation-result',
      requestId: message.requestId,
      observed: false,
      document: null,
    };
  }
  const document = message.document;
  if (typeof document !== 'object' || document === null) return null;
  const record = document as Record<string, unknown>;
  if (!isWebContentsId(record.webContentsId)) return null;
  if (!Number.isInteger(record.navigationId) || (record.navigationId as number) < 1) return null;
  return {
    astroix: CHANNEL_TAG,
    kind: 'host-observation-result',
    requestId: message.requestId,
    observed: true,
    document: { webContentsId: record.webContentsId, navigationId: record.navigationId as number },
  };
}

function liftAuthorityObservationRequest(
  message: Record<string, unknown>,
): DesktopChildRequest | null {
  if (
    message.kind === 'authority-observation' &&
    isRequestId(message.requestId) &&
    hasExactKeys(message, ['astroix', 'kind', 'requestId', 'observation']) &&
    isAuthorityObservation(message.observation)
  ) {
    return {
      astroix: CHANNEL_TAG,
      kind: 'authority-observation',
      requestId: message.requestId,
      observation: message.observation,
    };
  }
  return null;
}

/**
 * Lifts one unknown channel message into a child→main report. The same
 * closed-vocabulary discipline as the request parse: `null` for anything
 * the child never said — each kind has its own lifter so the envelope
 * fence stays per-shape (one closed key set per branch, never a merge).
 */
export function parseDesktopChildReport(message: unknown): DesktopChildReport | null {
  if (!isOwnMessage(message)) return null;
  return (
    liftBootedReport(message) ??
    liftSessionStateReport(message) ??
    liftRegisterResultReport(message) ??
    liftTransitionResultReport(message) ??
    liftObserveDocumentReport(message) ??
    liftReplaceTopLevelReport(message) ??
    liftAuthorityObservationResultReport(message) ??
    liftDocumentCapabilityReport(message)
  );
}

function liftBootedReport(message: Record<string, unknown>): DesktopChildReport | null {
  if (
    message.kind === 'booted' &&
    isPort(message.port) &&
    hasExactKeys(message, ['astroix', 'kind', 'port'])
  ) {
    return { astroix: CHANNEL_TAG, kind: 'booted', port: message.port };
  }
  return null;
}

function liftObserveDocumentReport(message: Record<string, unknown>): DesktopChildReport | null {
  if (
    message.kind === 'observe-document' &&
    isRequestId(message.requestId) &&
    hasExactKeys(message, ['astroix', 'kind', 'requestId'])
  ) {
    return { astroix: CHANNEL_TAG, kind: 'observe-document', requestId: message.requestId };
  }
  return null;
}

function liftReplaceTopLevelReport(message: Record<string, unknown>): DesktopChildReport | null {
  if (
    message.kind === 'replace-top-level' &&
    isRequestId(message.requestId) &&
    hasExactKeys(message, ['astroix', 'kind', 'requestId', 'sessionRef', 'projectKey', 'origin']) &&
    isSessionRef(message.sessionRef) &&
    typeof message.projectKey === 'string' &&
    message.projectKey.length > 0 &&
    typeof message.origin === 'string' &&
    message.origin.startsWith('http://')
  ) {
    return {
      astroix: CHANNEL_TAG,
      kind: 'replace-top-level',
      requestId: message.requestId,
      sessionRef: message.sessionRef,
      projectKey: message.projectKey,
      origin: message.origin,
    };
  }
  return null;
}

function liftAuthorityObservationResultReport(
  message: Record<string, unknown>,
): DesktopChildReport | null {
  if (
    message.kind === 'authority-observation-result' &&
    isRequestId(message.requestId) &&
    hasExactKeys(message, ['astroix', 'kind', 'requestId'])
  ) {
    return {
      astroix: CHANNEL_TAG,
      kind: 'authority-observation-result',
      requestId: message.requestId,
    };
  }
  return null;
}

function liftDocumentCapabilityReport(message: Record<string, unknown>): DesktopChildReport | null {
  if (
    message.kind === 'document-capability' &&
    hasExactKeys(message, ['astroix', 'kind', 'webContentsId', 'capability']) &&
    isWebContentsId(message.webContentsId) &&
    (message.capability === null || isCapability(message.capability))
  ) {
    return {
      astroix: CHANNEL_TAG,
      kind: 'document-capability',
      webContentsId: message.webContentsId,
      capability: message.capability,
    };
  }
  return null;
}

function liftSessionStateReport(message: Record<string, unknown>): DesktopChildReport | null {
  if (
    message.kind !== 'session-state' ||
    !hasExactKeys(message, ['astroix', 'kind', 'sessionRef'])
  ) {
    return null;
  }
  const ref = message.sessionRef;
  if (ref === null || isSessionRef(ref)) {
    return { astroix: CHANNEL_TAG, kind: 'session-state', sessionRef: ref };
  }
  return null;
}

function liftRegisterResultReport(message: Record<string, unknown>): DesktopChildReport | null {
  if (
    message.kind === 'register-result' &&
    isRequestId(message.requestId) &&
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
  return null;
}

function liftTransitionResultReport(message: Record<string, unknown>): DesktopChildReport | null {
  if (
    message.kind === 'transition-result' &&
    isRequestId(message.requestId) &&
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

/** Builds a host-observation reply (main side) — the observed identity, or the honest unobserved. */
export function hostObservationResultRequest(
  requestId: number,
  observed: boolean,
  document: HostDocumentIdentityReport | null,
): DesktopChildRequest {
  if (observed !== (document !== null)) {
    // A laundering builder would silently convert a wiring defect into
    // the unobserved branch — the honest reply for an observed ask
    // carries its document, and an unobserved one carries none.
    throw new Error(
      'an observed reply carries its document identity, and only an observed one does',
    );
  }
  if (observed && document !== null) {
    return {
      astroix: CHANNEL_TAG,
      kind: 'host-observation-result',
      requestId,
      observed: true,
      document,
    };
  }
  return {
    astroix: CHANNEL_TAG,
    kind: 'host-observation-result',
    requestId,
    observed: false,
    document: null,
  };
}

/** Builds an authority-observation request (main side) — the mirror's invalidation forward. */
export function authorityObservationRequest(
  requestId: number,
  observation: AuthorityObservation,
): DesktopChildRequest {
  return {
    astroix: CHANNEL_TAG,
    kind: 'authority-observation',
    requestId,
    observation,
  };
}

/** Builds a session-state report (child side). */
export function sessionStateReport(sessionRef: SessionRef | null): DesktopChildReport {
  return { astroix: CHANNEL_TAG, kind: 'session-state', sessionRef };
}

/** Builds the booted report (child side) — the composition's origin port rides it. */
export function bootedReport(port: number): DesktopChildReport {
  return { astroix: CHANNEL_TAG, kind: 'booted', port };
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

/** Builds the phase-1 handshake ask (child side) — the current authoritative document. */
export function observeDocumentRequest(requestId: number): DesktopChildReport {
  return { astroix: CHANNEL_TAG, kind: 'observe-document', requestId };
}

/** Builds the phase-2 handshake ask (child side) — replace the top level, observe the new document. */
export function replaceTopLevelRequest(input: {
  readonly requestId: number;
  readonly sessionRef: SessionRef;
  readonly projectKey: string;
  readonly origin: string;
}): DesktopChildReport {
  return {
    astroix: CHANNEL_TAG,
    kind: 'replace-top-level',
    requestId: input.requestId,
    sessionRef: input.sessionRef,
    projectKey: input.projectKey,
    origin: input.origin,
  };
}

/** Builds the authority-observation acknowledgement (child side). */
export function authorityObservationResultReport(requestId: number): DesktopChildReport {
  return { astroix: CHANNEL_TAG, kind: 'authority-observation-result', requestId };
}

/** Builds the live document capability report (child side) — the H4 injection's feed; null clears. */
export function documentCapabilityReport(
  webContentsId: number,
  capability: string | null,
): DesktopChildReport {
  return { astroix: CHANNEL_TAG, kind: 'document-capability', webContentsId, capability };
}
