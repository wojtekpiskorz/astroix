import { type SessionRef, sessionRefSchema } from './session';

/**
 * Generation-scoped query keys (ADR-0006 §5): TanStack Query keys start
 * with `['astroix', runtimeEpoch, generation, ...]` — the whole cache dies
 * with the session at commit, so a query key must never cross sessions.
 * At commit the client aborts old fetches, closes old SSE, and removes
 * old-generation queries before navigating; `sessionScopeFromQueryKey` is
 * the inverse read used to recognize (and purge) stale-scope keys.
 *
 * Deliberately dependency-free: the protocol package types the key shape
 * itself (`(string | number)[]`) rather than importing TanStack — the
 * query library is the app shell's concern, and the wire-side rule is
 * only about the leading triple.
 */
export const QUERY_KEY_ROOT = 'astroix';

/** The session-scoped leading triple every session-bound query key carries. */
export function sessionScope(ref: SessionRef): [string, string, number] {
  return [QUERY_KEY_ROOT, ref.runtimeEpoch, ref.generation];
}

/** A full generation-scoped query key: the session triple plus the resource scope. */
export function sessionQueryKey(
  ref: SessionRef,
  ...scope: (string | number)[]
): (string | number)[] {
  return [...sessionScope(ref), ...scope];
}

/**
 * Reads the session scope back out of a query key. Returns `null` when the
 * key is not session-scoped (wrong root or malformed pair) — never throws:
 * the consumer decides whether a null scope means "global" or "foreign".
 */
export function sessionScopeFromQueryKey(key: readonly unknown[]): SessionRef | null {
  const [root, runtimeEpoch, generation] = key;
  if (root !== QUERY_KEY_ROOT) return null;
  const parsed = sessionRefSchema.safeParse({ runtimeEpoch, generation });
  return parsed.success ? parsed.data : null;
}
