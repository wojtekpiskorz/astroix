import { describe, expect, it } from 'vitest';
import { COMPLETION_FAILURE } from '../../session-supervisor/completion/completion-result.ts';
import { neverSpawnedReport } from '../../session-supervisor/staging/activation-attempt.ts';
import {
  CLIENT_IDENTITY,
  cleanRevocation,
  completeCloseReport,
  completionDriver,
  completionFixture,
  EDITOR_DOC,
  fakeCandidate,
  flushMicrotasks,
  manualObservations,
  NEW_REF,
  OLD_REF,
  PROJECT_B,
  recordingTombstones,
} from './completion-harness.ts';

/**
 * The #239 focused tests, part 1 — the host-observed completion (ADR-0006
 * §4 step 6) and its irreversible failure aftermath (§4 step 7): the
 * three observed completions (the exact main-frame ready handshake,
 * launcher readiness, and the quit close without navigation), the
 * handshakes' failure legs, F6's `failed` grant consumed as input with
 * its fixed template and revoked accounting preserved, and the
 * no-old-session-resume law — the aftermath revokes and reaps, reports
 * the failed no-active state, and restores nothing.
 */

describe('the host-observed completions (§4 step 6)', () => {
  it('activation awaits the exact main-frame ready handshake — and only that seam', async () => {
    const fx = completionFixture();
    const completion = completionDriver(fx, recordingTombstones(fx.journal).tombstones);
    const observations = manualObservations(fx.journal);

    const pending = completion.completeReplacement({
      commit: { kind: 'committed', committed: NEW_REF, revoked: cleanRevocation(OLD_REF) },
      observations,
      client: CLIENT_IDENTITY,
      targetRemains: true,
    });
    observations.settleMainFrame(true);
    const result = await pending;

    expect(result).toEqual({
      kind: 'activation-completed',
      session: NEW_REF,
      target: CLIENT_IDENTITY,
    });
    // ONLY the main-frame seam ran: no launcher observation, no target
    // close — the activation's completion is the exact ready handshake.
    expect(fx.journal).toEqual(['observe:main-frame-ready']);
    expect(fx.reported).toEqual([]);
  });

  it('deactivation awaits launcher readiness — and only that seam', async () => {
    const fx = completionFixture();
    const completion = completionDriver(fx, recordingTombstones(fx.journal).tombstones);
    const observations = manualObservations(fx.journal);

    const pending = completion.completeReplacement({
      commit: { kind: 'deactivated', deactivated: OLD_REF, revoked: cleanRevocation(OLD_REF) },
      observations,
      client: CLIENT_IDENTITY,
      targetRemains: true,
    });
    observations.settleLauncher(true);
    const result = await pending;

    expect(result).toEqual({
      kind: 'deactivation-completed',
      session: OLD_REF,
      target: CLIENT_IDENTITY,
    });
    expect(fx.journal).toEqual(['observe:launcher-ready']);
  });

  it('quit closes the target without navigation — the close observation alone, never a ready seam', async () => {
    const fx = completionFixture();
    const completion = completionDriver(fx, recordingTombstones(fx.journal).tombstones);
    const observations = manualObservations(fx.journal);
    const revoked = cleanRevocation(OLD_REF);

    const pending = completion.completeQuit({
      commit: { kind: 'deactivated', deactivated: OLD_REF, revoked },
      observations,
    });
    observations.settleTargetClosed(true);
    const result = await pending;

    expect(result).toEqual({ kind: 'quit-completed', targetCloseObserved: true, revoked });
    // The quit's completion depends on NO navigation event: only the
    // close seam ran — the two ready seams were never touched.
    expect(fx.journal).toEqual(['observe:target-closed']);
  });

  it('quit still finishes when the close observation fails — the honest unobserved close (§8)', async () => {
    const fx = completionFixture();
    const completion = completionDriver(fx, recordingTombstones(fx.journal).tombstones);
    const observations = manualObservations(fx.journal);

    const pending = completion.completeQuit({
      commit: { kind: 'deactivated', deactivated: OLD_REF, revoked: cleanRevocation(OLD_REF) },
      observations,
    });
    observations.settleTargetClosed(false);
    const result = await pending;

    expect(result).toEqual({
      kind: 'quit-completed',
      targetCloseObserved: false,
      revoked: cleanRevocation(OLD_REF),
    });
  });

  it('quit refuses anything but a settled deactivation — nothing is driven', async () => {
    const fx = completionFixture();
    const completion = completionDriver(fx, recordingTombstones(fx.journal).tombstones);
    const observations = manualObservations(fx.journal);

    const result = await completion.completeQuit({
      commit: { kind: 'committed', committed: NEW_REF, revoked: cleanRevocation(OLD_REF) },
      observations,
    });

    expect(result).toEqual({ kind: 'rejected', reason: 'quit-requires-a-settled-deactivation' });
    expect(fx.journal).toEqual([]);
  });

  it("F6's pre-linearization rejection has no completion to observe", async () => {
    const fx = completionFixture();
    const completion = completionDriver(fx, recordingTombstones(fx.journal).tombstones);
    const observations = manualObservations(fx.journal);

    const result = await completion.completeReplacement({
      commit: { kind: 'rejected', reason: 'already-consumed' },
      observations,
      client: CLIENT_IDENTITY,
      targetRemains: true,
    });

    expect(result).toEqual({ kind: 'rejected', reason: 'transition-not-committed' });
    expect(fx.journal).toEqual([]);
  });
});

describe('host-observed completion failure — the irreversible aftermath (§4 step 7)', () => {
  /** Seats a granted candidate's authority on the real tables, then clears the seating noise. */
  function seatGrantedCandidate(fx: ReturnType<typeof completionFixture>): {
    readonly cookie: string;
    readonly capability: string;
    readonly httpCapability: string;
  } {
    const cookie = fx.capabilityGrants.mint({ host: 'project', projectKey: PROJECT_B });
    const bound = fx.clients.bind({ role: 'editor', document: EDITOR_DOC, sessionRef: NEW_REF });
    const http = fx.httpBindings.bind({ role: 'editor', host: 'project', sessionRef: NEW_REF });
    if (bound.kind !== 'bound' || http.kind !== 'bound') throw new Error('expected the seating');
    fx.liveGrants.set(`${NEW_REF.runtimeEpoch}#${NEW_REF.generation}`, 3);
    fx.journal.length = 0;
    return { cookie, capability: bound.capability, httpCapability: http.capability };
  }

  it('a main-frame handshake failure revokes and reaps the granted candidate, shows the launcher, and reports the failed no-active state', async () => {
    const fx = completionFixture();
    const completion = completionDriver(fx, recordingTombstones(fx.journal).tombstones);
    const observations = manualObservations(fx.journal);
    const seated = seatGrantedCandidate(fx);
    const candidate = fakeCandidate(fx.journal, NEW_REF, PROJECT_B, seated.httpCapability);

    const pending = completion.completeReplacement({
      commit: { kind: 'committed', committed: NEW_REF, revoked: cleanRevocation(OLD_REF) },
      observations,
      client: CLIENT_IDENTITY,
      candidate: candidate.target,
      targetRemains: true,
    });
    observations.settleMainFrame(false);
    await flushMicrotasks(); // the ordered candidate revocation runs; the reap seam is called
    const reapReport = completeCloseReport('stopped');
    candidate.settleClose(reapReport);
    await flushMicrotasks(); // the reap resolves; the launcher show is called
    observations.settleLauncher(true);
    const result = await pending;

    if (result.kind !== 'failed')
      throw new Error(`expected the failed result, got: ${result.kind}`);
    expect(result.failure).toEqual(COMPLETION_FAILURE);
    expect(result.target).toEqual(CLIENT_IDENTITY);
    expect(result.revoked).toEqual(cleanRevocation(OLD_REF));
    expect(result.aftermath.candidateRevoked).toBe(true);
    expect(result.aftermath.candidateClose).toBe(reapReport);
    expect(result.aftermath.launcherObserved).toBe(true);
    // The §4 step 7 order, exactly: the candidate's five-surface ordered
    // revocation (authority) BEFORE its reap (children), then the
    // launcher show, then the failed no-active state report.
    expect(fx.journal).toEqual([
      'observe:main-frame-ready',
      'streams:endForBinding',
      'streams:endForHost',
      'streams:endForSession',
      'candidate-routes:revoke',
      'edit-grants:revokeSession',
      'clients:revokeSession',
      'http-bindings:unbind',
      'host-capability:revoke',
      'candidate:stop-run',
      'observe:launcher-ready',
      'report:failed-no-active',
    ]);
    expect(fx.reported).toEqual([COMPLETION_FAILURE]);
  });

  it('the granted authority is really gone — nothing resumes, nothing re-mints', async () => {
    const fx = completionFixture();
    const completion = completionDriver(fx, recordingTombstones(fx.journal).tombstones);
    const observations = manualObservations(fx.journal);
    const seated = seatGrantedCandidate(fx);
    const candidate = fakeCandidate(fx.journal, NEW_REF, PROJECT_B, seated.httpCapability);

    const pending = completion.completeReplacement({
      commit: { kind: 'committed', committed: NEW_REF, revoked: cleanRevocation(OLD_REF) },
      observations,
      client: CLIENT_IDENTITY,
      candidate: candidate.target,
      targetRemains: false,
    });
    observations.settleMainFrame(false);
    await flushMicrotasks(); // the revocation pass runs; the reap seam is called
    candidate.settleClose(completeCloseReport('stopped'));
    const result = await pending;
    if (result.kind !== 'failed') throw new Error('unreachable');

    // The aftermath restored NOTHING: every authority the granted
    // candidate held is dead on the real tables, and the journal holds
    // only revoking calls — no mint, no bind, no resume.
    expect(
      fx.capabilityGrants.verify(seated.cookie, { host: 'project', projectKey: PROJECT_B }),
    ).toBe(false);
    expect(
      fx.clients.authorize({
        capability: seated.capability,
        document: EDITOR_DOC,
        sessionRef: NEW_REF,
        role: 'editor',
      }),
    ).toEqual({ kind: 'rejected', reason: 'no-binding' });
    expect(fx.httpBindings.resolve(seated.httpCapability)).toBe(null);
    expect(
      fx.journal.some(
        (entry) =>
          entry === 'host-capability:mint' ||
          entry === 'clients:bind' ||
          entry === 'http-bindings:bind',
      ),
    ).toBe(false);
  });

  it('a launcher readiness failure after deactivation reports the failed no-active state — no candidate exists to revoke', async () => {
    const fx = completionFixture();
    const completion = completionDriver(fx, recordingTombstones(fx.journal).tombstones);
    const observations = manualObservations(fx.journal);

    const pending = completion.completeReplacement({
      commit: { kind: 'deactivated', deactivated: OLD_REF, revoked: cleanRevocation(OLD_REF) },
      observations,
      client: CLIENT_IDENTITY,
      targetRemains: true,
    });
    observations.settleLauncher(false); // the deactivation's own launcher show failed
    await flushMicrotasks(); // the aftermath's launcher show is called (a target remains)
    observations.settleLauncher(false); // and was not observed either — the honest false
    const result = await pending;

    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.failure).toEqual(COMPLETION_FAILURE);
    expect(result.aftermath).toEqual({
      candidateRevoked: false,
      candidateClose: null,
      launcherObserved: false, // the launcher show itself was not observed
    });
    // Two launcher observations: the deactivation's own show (failed),
    // then the aftermath's show attempt (§4 step 7) — also unobserved.
    expect(fx.journal).toEqual([
      'observe:launcher-ready',
      'observe:launcher-ready',
      'report:failed-no-active',
    ]);
    expect(fx.reported).toEqual([COMPLETION_FAILURE]);
  });

  it('no target remains: the launcher is never shown, the failure is still reported', async () => {
    const fx = completionFixture();
    const completion = completionDriver(fx, recordingTombstones(fx.journal).tombstones);
    const observations = manualObservations(fx.journal);
    const seated = seatGrantedCandidate(fx);
    const candidate = fakeCandidate(fx.journal, NEW_REF, PROJECT_B, seated.httpCapability);

    const pending = completion.completeReplacement({
      commit: { kind: 'committed', committed: NEW_REF, revoked: cleanRevocation(OLD_REF) },
      observations,
      client: CLIENT_IDENTITY,
      candidate: candidate.target,
      targetRemains: false,
    });
    observations.settleMainFrame(false);
    await flushMicrotasks(); // the revocation pass runs; the reap seam is called
    candidate.settleClose(completeCloseReport('stopped'));
    const result = await pending;

    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.aftermath.launcherObserved).toBe(false);
    expect(fx.journal).not.toContain('observe:launcher-ready');
    expect(fx.reported).toEqual([COMPLETION_FAILURE]);
  });

  it("F6's irreversible failed grant is consumed as the aftermath's input — fixed template and revoked accounting preserved, no candidate to revoke", async () => {
    const fx = completionFixture();
    const completion = completionDriver(fx, recordingTombstones(fx.journal).tombstones);
    const observations = manualObservations(fx.journal);
    const f6Failure = {
      category: 'revocation',
      message: 'the session commit failed after the outgoing authority was revoked',
    } as const;

    const pending = completion.completeReplacement({
      commit: { kind: 'failed', failure: f6Failure, revoked: cleanRevocation(OLD_REF) },
      observations,
      client: CLIENT_IDENTITY,
      targetRemains: true,
    });
    observations.settleLauncher(true);
    const result = await pending;

    if (result.kind !== 'failed') throw new Error('unreachable');
    // The input's fixed template and revoked accounting are THE result's:
    // the aftermath reports the same failure, unchanged.
    expect(result.failure).toEqual(f6Failure);
    expect(result.revoked).toEqual(cleanRevocation(OLD_REF));
    expect(result.aftermath).toEqual({
      candidateRevoked: false, // the grant refused — no candidate authority exists
      candidateClose: null,
      launcherObserved: true,
    });
    expect(fx.reported).toEqual([f6Failure]);
  });

  it('a rejecting candidate reap converges on the never-spawned report (the E8 stop law)', async () => {
    const fx = completionFixture();
    const completion = completionDriver(fx, recordingTombstones(fx.journal).tombstones);
    const observations = manualObservations(fx.journal);
    const seated = seatGrantedCandidate(fx);
    const candidate = fakeCandidate(fx.journal, NEW_REF, PROJECT_B, seated.httpCapability);

    const pending = completion.completeReplacement({
      commit: { kind: 'committed', committed: NEW_REF, revoked: cleanRevocation(OLD_REF) },
      observations,
      client: CLIENT_IDENTITY,
      candidate: candidate.target,
      targetRemains: false,
    });
    observations.settleMainFrame(false);
    await flushMicrotasks(); // the revocation pass runs; the reap seam is called
    candidate.refuseClose();
    const result = await pending;

    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.aftermath.candidateClose).toEqual(neverSpawnedReport());
    expect(fx.reported).toEqual([COMPLETION_FAILURE]);
  });
});
