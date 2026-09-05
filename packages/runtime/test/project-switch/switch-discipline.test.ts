import type {
  RequestEnvelope,
  ResponseEnvelope,
  SessionSnapshot,
} from '@wojciechpiskorz/astroix-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACTIVATION_BUDGET_MS,
  createSwitchHarness,
  launcherDocument,
  planePids,
  pollUntil,
  SETTLE_BUDGET_MS,
  type SwitchHarness,
} from './harness.ts';

// @vitest-environment node — real managed `astro dev` children, real
// loopback sockets; no DOM, no stand-ins.

/**
 * The composition's switch-discipline battery (#411, #412, #413 — the
 * defects K1's proof lane found and scoped around): the real
 * control-plane composition through the REAL wire (the shared A-B-A
 * harness), pinning the three activation/deactivation laws the fix
 * wired —
 *
 * 1. the deactivation inform (#411): a settled deactivation empties
 *    the supervisor's active entry cleanly — no `crash` lastFailure
 *    when the outgoing run's late stop settles, and the NEXT
 *    activation's envelope carries no poisoned failure;
 * 2. the idempotent same-project re-activation (#413): activating the
 *    already-active project answers the CURRENT session's activation
 *    envelope — same pair, no fresh generation, no staged second plane
 *    — and the active session's run stays alive and serving;
 * 3. the in-flight-safe refusal (#412): a concurrent activation
 *    refused through the wire (409) wipes nothing of the in-flight
 *    attempt — the winner's adoption is whole (inspects serve, the
 *    origin lease routes to the real dev-server port) and its plane
 *    dies at the deactivation, never past it.
 *
 * The legs walk ONE serial session history (one composition, one
 * supervisor-global active session — the K-family's own discipline):
 * leg 1 ends with A re-activated, leg 2 re-activates that same A
 * idempotently, leg 3 races the switch to B and deactivates. The
 * sibling battery (`server-authority.test.ts`) holds the stale-authority
 * spine; this file owns the switch-discipline laws alone.
 */

/** The error envelope's code — every refusal assertion reads the closed vocabulary. */
function errorCode(body: string): string {
  return (JSON.parse(body) as { error?: { code?: string } }).error?.code ?? 'none';
}

/** One bounded sleep — the observation window's interval. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

/**
 * Asserts the supervisor's truth stays failure-free across a bounded
 * observation window — the crash observer's own firing window (#411's
 * probe): the bogus crash recorded when the stopped run's late close
 * arrives lands here or never.
 */
async function expectNoFailureAcross(harness: SwitchHarness, windowMs: number): Promise<void> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const snapshot: SessionSnapshot = harness.snapshot();
    expect(snapshot.lastFailure).toBeUndefined();
    if (Date.now() >= deadline) return;
    await sleep(100);
  }
}

/** Pair equality over optional sides — `undefined` never equals a pair. */
function samePair(
  a: { readonly runtimeEpoch: string; readonly generation: number } | undefined,
  b: { readonly runtimeEpoch: string; readonly generation: number } | undefined,
): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.runtimeEpoch === b.runtimeEpoch &&
    a.generation === b.generation
  );
}

describe('the composition\u2019s switch discipline (#411, #412, #413)', () => {
  let harness: SwitchHarness;

  beforeAll(async () => {
    harness = await createSwitchHarness();
  }, ACTIVATION_BUDGET_MS);

  afterAll(async () => {
    if (harness === undefined) return;
    await harness.close();
    // Runner hygiene, never an assertion (the sibling battery's belt): a
    // leg that fails mid-history can leave plane children alive past the
    // composition's close.
    for (const pid of await planePids(harness)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  });

  it('informs the revoke seam on deactivation — no bogus crash, no poisoned later envelope (#411)', {
    timeout: 480_000,
  }, async () => {
    // A commits; the deactivation then settles the transition.
    const a1 = await harness.activate(harness.projectA);
    const deactivation = await harness.deactivate();
    expect(deactivation.status, deactivation.body).toBe(200);
    // The wire result carries the CLEAN clear — the supervisor's active
    // entry is already empty and no failure was recorded (pre-fix: the
    // snapshot still showed the deactivated pair as active/ready).
    const stopped = JSON.parse(deactivation.body) as ResponseEnvelope;
    if (stopped.result.kind !== 'deactivation') {
      throw new Error(`the deactivation answered ${stopped.result.kind} — a wire defect`);
    }
    expect(stopped.result.snapshot.active).toBeUndefined();
    expect(stopped.result.snapshot.lastFailure).toBeUndefined();

    // The outgoing plane drains — the exact moment the un-wired crash
    // observer used to fire its bogus failure on the late close.
    await pollUntil(async () => (await planePids(harness)).length === 0, SETTLE_BUDGET_MS);
    // Across the observation window: no active session, and NO failure —
    // a supervised deactivation is never a crash (pre-fix: `crash — the
    // active project session terminated unexpectedly`).
    await expectNoFailureAcross(harness, 2_000);
    expect(harness.snapshot().active).toBeUndefined();

    // The next activation's envelope is un-poisoned: committed, and its
    // snapshot carries the fresh pair with no failure riding it.
    const a2 = await harness.activate(harness.projectA);
    expect(a2.document.session.generation).toBeGreaterThan(a1.document.session.generation);
    if (a2.envelope.result.kind !== 'activation') {
      throw new Error(`the activation answered ${a2.envelope.result.kind} — a wire defect`);
    }
    expect(a2.envelope.result.snapshot.lastFailure).toBeUndefined();
  });

  it('answers same-project re-activation idempotently — the active session survives untouched (#413)', {
    timeout: 480_000,
  }, async () => {
    // A is the active session (leg 1 re-activated it); the same project's
    // activation arrives through the launcher — the double-click shape.
    const before = harness.snapshot();
    const seated = before.active;
    expect(seated?.state).toBe('ready');
    const launcher = await launcherDocument(harness.port);
    const again = await harness.post(
      {
        protocolVersion: 1,
        requestId: 'reactivate-a',
        command: { kind: 'activate', projectKey: harness.projectA.key },
      } satisfies RequestEnvelope,
      { cookie: launcher.cookie, client: launcher.client },
    );
    // The chosen semantics, disclosed: the idempotent no-op — the
    // requested postcondition already holds, so the CURRENT session's
    // activation envelope answers 200: same pair, NO fresh generation,
    // nothing staged (pre-fix: a staged second plane for the same root
    // crashed the active session and left a zombie ready-labeled entry).
    expect(again.status, again.body).toBe(200);
    const envelope = JSON.parse(again.body) as ResponseEnvelope;
    if (envelope.result.kind !== 'activation') {
      throw new Error(`the re-activation answered ${envelope.result.kind} — a wire defect`);
    }
    expect(envelope.result.target.projectKey).toBe(harness.projectA.key);
    expect(samePair(envelope.result.target.session, seated?.ref)).toBe(true);
    expect(envelope.result.target.session.generation).toBe(seated?.ref.generation);
    expect(samePair(envelope.result.snapshot.active?.ref, seated?.ref)).toBe(true);
    expect(envelope.result.snapshot.active?.state).toBe('ready');
    expect(envelope.result.snapshot.lastFailure).toBeUndefined();

    // The supervisor's truths are consistent: the same active pair, no
    // attempt ever staged, no failure recorded.
    const after = harness.snapshot();
    expect(samePair(after.active?.ref, seated?.ref)).toBe(true);
    expect(after.active?.state).toBe('ready');
    expect(after.attempt).toBeUndefined();
    expect(after.lastFailure).toBeUndefined();

    // And the active session's run is ALIVE — the very next inspection
    // serves through the unchanged seat (pre-fix: the session was dead).
    const document = await harness.projectDocument();
    const serving = await harness.inspect({ kind: 'project' }, document);
    expect(serving.status, serving.body).toBe(200);
  });

  it('refuses the concurrent activation in-flight-safely — the winner\u2019s adoption is whole (#412)', {
    timeout: 480_000,
  }, async () => {
    // A is active; the switch to B begins, and a second activation for
    // the same target races the in-flight window.
    const before = harness.snapshot().active?.ref.generation ?? 0;
    const inFlight = harness.activate(harness.projectB);
    await pollUntil(async () => harness.snapshot().attempt !== undefined, SETTLE_BUDGET_MS, 25);
    const launcher = await launcherDocument(harness.port);
    const race = await harness.post(
      {
        protocolVersion: 1,
        requestId: 'race-b',
        command: { kind: 'activate', projectKey: harness.projectB.key },
      } satisfies RequestEnvelope,
      { cookie: launcher.cookie, client: launcher.client },
    );
    expect(race.status).toBe(409);
    expect(errorCode(race.body)).toBe('concurrent-activation');
    expect((JSON.parse(race.body) as { error?: { retryable?: boolean } }).error?.retryable).toBe(
      true,
    );

    // The winner lands at a fresh generation — and its adoption is
    // WHOLE: the refused request wiped nothing, so the remembered run
    // seats, the lease's upstream is the real dev-server port (pre-fix:
    // the seat adopted a never-spawned run — inspects 500, upstream -1,
    // the plane leaked past every close).
    const winner = await inFlight;
    expect(winner.document.session.generation).toBeGreaterThan(before);
    const whole = await harness.inspect({ kind: 'project' }, winner.document);
    expect(whole.status, whole.body).toBe(200);
    const routed = await harness.fetchProxied(winner.document, '/@vite/client');
    expect(routed.status).toBe(200);

    // And the winner's plane never outlives its session: the
    // deactivation stops exactly the registered run (pre-fix: the real
    // children were outside every seat and survived the close).
    expect((await harness.deactivate()).status).toBe(200);
    await pollUntil(async () => (await planePids(harness)).length === 0, SETTLE_BUDGET_MS);
  });
});
