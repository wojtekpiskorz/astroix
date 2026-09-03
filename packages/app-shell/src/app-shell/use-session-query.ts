import { useQuery } from '@tanstack/react-query';
import { gatedSessionFetch } from '../query/gated-session-fetch.ts';
import { useShell } from './shell-context.ts';

/**
 * The shell's session query hook (#241, G2; ADR-0006 §5): server-derived
 * session data through TanStack Query under the generation-scoped key —
 * `['astroix', runtimeEpoch, generation, ...scope]`, minted by the
 * SessionClient (the AC's every-session-query-key law, by construction)
 * — with the stale-response belt around the fetch and the session's
 * abort signal chained in, so the reset's `abort-fetches` step cancels
 * every live session query and a moved-past resolution never lands.
 */

/** One session query: key from the SessionClient, belt around the fetch, session abort chained. */
export function useSessionQuery<T>(
  scope: readonly (string | number)[],
  fetch: (signal?: AbortSignal) => Promise<T>,
) {
  const { session, gate, sessionAbort, queryClient } = useShell();
  const gatedFetch = gatedSessionFetch(gate, fetch);
  return useQuery(
    {
      queryKey: session.queryKey(...scope),
      queryFn: ({ signal }) => gatedFetch(linkSignals(sessionAbort, signal)),
    },
    queryClient,
  );
}

/** Chains the session abort and the query's own signal — either aborting cancels the exchange. */
function linkSignals(sessionAbort: AbortSignal, querySignal: AbortSignal | undefined): AbortSignal {
  return querySignal === undefined ? sessionAbort : AbortSignal.any([sessionAbort, querySignal]);
}
