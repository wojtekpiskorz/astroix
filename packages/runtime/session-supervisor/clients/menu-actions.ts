import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';

/**
 * The menu-action currency envelope (#236, F4; ADR-0006 §5 "Menu actions
 * capture the `SessionRef` visible at creation and reject if stale at
 * execution"): the native (Electron-main) menu builds its session-scoped
 * items against the session visible when the menu was created; the click
 * executes later, against whatever session is current — the envelope
 * freezes the captured pair at creation and the executor re-checks it.
 *
 * After an A-to-B-to-A cycle the first A's menu items carry the retired
 * pair and are rejected as stale; after a control-plane restart the
 * epoch itself differs. The action id is opaque here — the native menu's
 * own vocabulary; this module owns only the currency law. The
 * `SessionRef` is correlation and freshness data, never authentication
 * (CONTEXT.md) — a stale rejection is about not acting on a dead
 * session, not about proving who asked.
 */

/** One captured menu action: the pair visible at creation, frozen into the envelope. */
export interface MenuActionEnvelope {
  readonly sessionRef: SessionRef;
  /** The native menu's action id — opaque to this module, carried untouched. */
  readonly action: string;
}

/** Why a menu action was refused at execution — sanitized vocabulary only. */
export type MenuActionRejection = 'no-active-session' | 'stale-session';

/** Captures one menu action against the session visible at menu creation. */
export function captureMenuAction(input: {
  readonly sessionRef: SessionRef;
  readonly action: string;
}): MenuActionEnvelope {
  return { sessionRef: input.sessionRef, action: input.action };
}

/**
 * Executes one captured action against the currently active session (the
 * caller reads it off the supervisor snapshot): the captured pair must be
 * the exact current pair — epoch and generation both — or the action is
 * rejected without executing.
 */
export function executeMenuAction(
  envelope: MenuActionEnvelope,
  current: SessionRef | null,
):
  | { readonly kind: 'accepted'; readonly sessionRef: SessionRef }
  | { readonly kind: 'rejected'; readonly reason: MenuActionRejection } {
  if (current === null) {
    return { kind: 'rejected', reason: 'no-active-session' };
  }
  if (
    envelope.sessionRef.runtimeEpoch !== current.runtimeEpoch ||
    envelope.sessionRef.generation !== current.generation
  ) {
    return { kind: 'rejected', reason: 'stale-session' };
  }
  return { kind: 'accepted', sessionRef: current };
}
