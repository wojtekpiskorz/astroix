import { type SessionRef, sessionQueryKey } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import { createSessionGate } from '../state/session-gate.ts';
import { armContentRetryBelt, type ContentRetryBelt } from './content-retry-belt.ts';
import { createShellQueryClient } from './shell-query-client.ts';

/**
 * The content-family convergence retry belt (#451): the torn truth
 * #450/#387 disclosed — the first refetch a content-family push causes
 * can read the PRE-edit listing (the served projection trails the file
 * write) — closed client-side over the payload's own deterministic
 * revision marker. These legs drive the belt directly over a real
 * QueryClient (the panel's mounted observer is the wiring leg's
 * business, in shell-provider.test.tsx): the served script controls the
 * marker each fetch returns, and every assertion is the wire's own
 * truth — how many content inspections actually dispatched, and what
 * the cache holds — never the belt's internals.
 */

const REF: SessionRef = { runtimeEpoch: 'epoch-belt', generation: 1 };

/** The belt's session slice — the real key minter, the only member the belt reads. */
const session = {
  queryKey: (...scope: (string | number)[]) => sessionQueryKey(REF, ...scope),
};

/** The test schedule — four fast hops; the production default is the chartered 250→500→1000→2000. */
const FAST_DELAYS_MS: readonly number[] = [5, 5, 5, 5];

/** One leg's rig: the scripted content query, the fetch counter, the belt's fixed inputs. */
function beltRig(served: readonly unknown[]) {
  const queryClient = createShellQueryClient();
  let fetches = 0;
  let cursor = 0;
  const query = {
    queryKey: session.queryKey('content'),
    queryFn: async (): Promise<{ kind: 'content'; revision: number; payload: unknown }> => {
      // The script holds the served projection per fetch, clamping at its
      // last entry (a torn-then-converged script ends converged forever).
      const payload = served[Math.min(cursor, served.length - 1)];
      cursor += 1;
      fetches += 1;
      return { kind: 'content', revision: fetches, payload: { revision: payload } };
    },
  };
  const gate = createSessionGate(REF);
  const controller = new AbortController();
  const arm = (firstRefetch: Promise<unknown>): ContentRetryBelt =>
    armContentRetryBelt(
      { queryClient, session, gate, signal: controller.signal, retryDelaysMs: FAST_DELAYS_MS },
      firstRefetch,
    );
  return {
    arm,
    fetches: () => fetches,
    gate,
    controller,
    queryClient,
    /** Seeds the cache the way a mounted panel's first fetch would (one dispatch). */
    seed: () => queryClient.prefetchQuery(query),
    /** The bridge's refetch shape — the settle the belt observes first. */
    bridgeRefetch: () =>
      queryClient.refetchQueries(
        { queryKey: session.queryKey('content') },
        { cancelRefetch: false },
      ),
    /** The content key's cached marker — the convergence truth the cache holds. */
    cachedMarker: (): unknown =>
      (
        queryClient.getQueryData(session.queryKey('content')) as {
          payload?: { revision?: unknown };
        }
      )?.payload?.revision,
  };
}

/** Settles beyond the whole injected schedule — a further retry would surface inside this window. */
async function settleBelt(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

describe('the content-family convergence retry belt (#451)', () => {
  it('converges on the first refetch — a moved marker never schedules a retry', async () => {
    const rig = beltRig(['r0', 'r1']);
    await rig.seed();
    expect(rig.fetches()).toBe(1);
    const belt = rig.arm(rig.bridgeRefetch());
    await settleBelt();
    belt.cancel();
    // The push's own refetch moved the marker: exactly two content
    // inspections total (the seed and the bridge's), zero belt retries.
    expect(rig.fetches()).toBe(2);
    expect(rig.cachedMarker()).toBe('r1');
  });

  it('converges on the Nth retry — torn truths re-fetch until the marker moves', async () => {
    const rig = beltRig(['r0', 'r0', 'r0', 'r1']);
    await rig.seed();
    const belt = rig.arm(rig.bridgeRefetch());
    // fetch 1: the seed; fetch 2: the bridge's refetch (torn); fetches 3
    // and 4: the belt's first two backoff retries (torn, then moved).
    const deadline = Date.now() + 2000;
    while (rig.fetches() < 4 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await settleBelt();
    belt.cancel();
    expect(rig.fetches()).toBe(4);
    expect(rig.cachedMarker()).toBe('r1');
  });

  it('stops at the budget when the projection never converges — four retries, then quiet', async () => {
    const rig = beltRig(['r0']);
    await rig.seed();
    const belt = rig.arm(rig.bridgeRefetch());
    // fetch 1: the seed; fetch 2: the bridge's refetch; fetches 3-6: the
    // four scheduled retries — the schedule's end is the honest give-up.
    const deadline = Date.now() + 2000;
    while (rig.fetches() < 6 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await settleBelt();
    belt.cancel();
    expect(rig.fetches()).toBe(6);
    // The give-up keeps the served truth: the pre-push listing stands
    // (honest — the next push re-arms the belt).
    expect(rig.cachedMarker()).toBe('r0');
  });

  it('a generation change cancels the pending belt — a closed gate and an aborted session never retry', async () => {
    // The gate closes (the reset's move to null) before the first hop:
    // the belt's retries never dispatch.
    const gated = beltRig(['r0', 'r0']);
    await gated.seed();
    gated.gate.move(null);
    const gateBelt = gated.arm(gated.bridgeRefetch());
    await settleBelt();
    gateBelt.cancel();
    expect(gated.fetches()).toBe(2); // the seed and the bridge's refetch only

    // The session abort (the reset's abort-fetches step) cancels mid-belt:
    // a torn first refetch schedules a retry the abort then kills.
    const aborted = beltRig(['r0', 'r0']);
    await aborted.seed();
    const abortBelt = aborted.arm(aborted.bridgeRefetch());
    aborted.controller.abort();
    await settleBelt();
    abortBelt.cancel();
    expect(aborted.fetches()).toBe(2);
  });

  it('disarms fail-safe when the payload carries no convergence marker — never a spin', async () => {
    // No cached marker at push time means there is nothing to converge
    // against (a first-ever fetch, or a payload that carries none): the
    // belt arms to nothing — distinguishable from the budget leg by the
    // absence of ANY retry dispatch.
    const rig = beltRig([null]);
    await rig.seed();
    const belt = rig.arm(rig.bridgeRefetch());
    await settleBelt();
    belt.cancel();
    expect(rig.fetches()).toBe(2);
  });
});
