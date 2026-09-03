import { QueryClient } from '@tanstack/react-query';

/**
 * The shell's QueryClient factory (#241, G2; ADR-0006 §5: the HOST owns
 * the QueryClient — this factory is the shell's doctrine-shaped
 * constructor every host calls once per document).
 *
 * Cache doctrine: the client holds session-derived data in memory only,
 * keyed by the generation-scoped triple (`['astroix', runtimeEpoch,
 * generation, …]` — the SessionClient mints the keys), so the whole
 * cache dies with the session at the reset's `remove-queries` step —
 * never through HTTP caching. `no-store` behavior (the AC's
 * responses/assets clause) is transport- and document-level truth: the
 * AppClient issues every exchange with `cache: 'no-store'`, and the
 * host's document surface serves pages and assets `Cache-Control:
 * no-store` (protocol v1) — this factory adds no HTTP layer of its own.
 *
 * Protocol errors are never retried blindly (their envelope says
 * whether they are retryable); window focus never refetches (session
 * data is revision-driven — SSE invalidations refetch it).
 */
export function createShellQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}
