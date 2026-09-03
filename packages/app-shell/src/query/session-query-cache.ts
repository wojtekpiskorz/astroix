import type { QueryClient } from '@tanstack/react-query';
import { type SessionRef, sessionScopeFromQueryKey } from '@wojciechpiskorz/astroix-protocol';
import { sameSessionPair } from '../state/session-gate.ts';

/**
 * The generation-scoped cache discipline over the host's QueryClient
 * (#241, G2; ADR-0006 §5): every session query key begins with
 * `['astroix', runtimeEpoch, generation]` (the SessionClient's
 * `queryKey` mints it; the protocol's `sessionScopeFromQueryKey` reads
 * it back), and the reset's `remove-queries` step removes exactly the
 * session-scoped entries — the whole cache dies with the session, by
 * construction, before navigation.
 */

/** True when the key is session-scoped — the `astroix` root plus a well-formed pair. */
export function isSessionQueryKey(key: readonly unknown[]): boolean {
  return sessionScopeFromQueryKey(key) !== null;
}

/**
 * Removes the session-scoped queries. With `keep`: removes every
 * session-scoped entry whose pair is NOT `keep` (a switch's
 * old-generation removal). Without: removes every session-scoped entry
 * (the deactivation reset — no next generation exists). Non-session
 * keys are never this discipline's business.
 */
export function removeSessionQueries(queryClient: QueryClient, keep?: SessionRef): void {
  queryClient.removeQueries({
    predicate: (query) => {
      const scope = sessionScopeFromQueryKey(query.queryKey);
      if (scope === null) return false;
      return keep === undefined || !sameSessionPair(scope, keep);
    },
  });
}

/** How many session-scoped queries the cache holds — the shell-state marker's count. */
export function sessionQueryCount(queryClient: QueryClient): number {
  return queryClient
    .getQueryCache()
    .getAll()
    .filter((q) => isSessionQueryKey(q.queryKey)).length;
}
