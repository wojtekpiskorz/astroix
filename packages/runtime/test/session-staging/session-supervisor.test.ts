import {
  ERROR_HTTP_STATUS,
  findDisclosure,
  sessionLabel,
  sessionSnapshotSchema,
} from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import { createHostCapabilityGrants } from '../../api/http/host-capability.ts';
import type { SupervisionCloseReport } from '../../project-plane/supervision/close-report.ts';
import type { ProjectRun } from '../../project-runtime/project-runtime.ts';
import {
  type ClientDocument,
  createSessionClients,
} from '../../session-supervisor/clients/session-clients.ts';
import {
  type AttemptHooks,
  createActivationAttempt,
  neverSpawnedReport,
} from '../../session-supervisor/staging/activation-attempt.ts';
import {
  type ActivationAttempt,
  ActivationFailedError,
  createSessionSupervisor,
  FAILURE_MESSAGES,
  type SessionSupervisor,
  StageRejectedError,
} from '../../session-supervisor/staging/session-supervisor.ts';
import {
  type CandidateRuntimeControl,
  candidateRuntime,
  completeReport,
  type FakeRun,
  fakeRun,
  flush,
  PROJECT_A,
  PROJECT_B,
  rejectionOf,
  settlementOf,
} from './staging-harness.ts';

/**
 * The #236 focused tests, part 1 — the staged activation state machine:
 * the snapshot as the source of truth (never a flat enum), generation
 * reservation with the concurrent-activation refusal (the protocol's
 * 409), the one-active-plane-per-root same-root refusal (#420), private
 * candidate readiness under a still-authoritative old
 * session, rollback-before-commit preserving the old ready session,
 * cancellation, the commit linearization, crash observation without
 * automatic restart, snapshot notifications, and the output-hygiene
 * sweep over every failure message the surface can produce.
 */

/** The hostile text a misbehaving seam leaks — it must never surface (the E6 law). */
const HOSTILE = 'cannot resolve astro at /Users/secret/root-236 (pid 4242, port 9999)';

interface Fixture {
  readonly supervisor: SessionSupervisor;
  readonly control: CandidateRuntimeControl;
}

function fixture(epoch = 'epoch-236'): Fixture {
  const control = candidateRuntime();
  const supervisor = createSessionSupervisor({
    startCandidate: control.startCandidate,
    runtimeEpoch: epoch,
  });
  return { supervisor, control };
}

/** The run the nth launch (1-based generation) handed back. */
function runOf(control: CandidateRuntimeControl, generation: number): FakeRun {
  const run = control.runs[generation - 1];
  if (run === undefined) throw new Error(`no fake run for generation ${generation}`);
  return run;
}

/** The begun attempt, or a thrown expectation when it was refused. */
function begunOf(result: ReturnType<SessionSupervisor['begin']>): ActivationAttempt {
  if (result.kind !== 'begun')
    throw new Error(`expected the attempt to be admitted: ${result.reason}`);
  return result.attempt;
}

/** Begins one attempt and readies its candidate — the common activation prefix. */
async function staged(
  sup: SessionSupervisor,
  control: CandidateRuntimeControl,
  projectKey = PROJECT_A,
): Promise<{
  attempt: ActivationAttempt;
  candidate: Awaited<ActivationAttempt['ready']>;
  run: FakeRun;
}> {
  const attempt = begunOf(sup.begin(projectKey));
  const run = control.runs[control.runs.length - 1];
  if (run === undefined) throw new Error('no run was started');
  run.settleReady();
  const candidate = await attempt.ready;
  return { attempt, candidate, run };
}

describe('snapshot — the source of truth, never a flat enum', () => {
  it('starts empty and schema-valid: idle, no invented fields', () => {
    const { supervisor } = fixture();
    const snapshot = supervisor.snapshot();
    expect(snapshot).toEqual({});
    expect(sessionSnapshotSchema.parse(snapshot)).toEqual({});
    expect(sessionLabel(snapshot)).toBe('idle');
  });

  it('an in-flight attempt reports attempt {starting} with its reserved reference — schema-valid at every step', async () => {
    const { supervisor, control } = fixture();
    const attempt = begunOf(supervisor.begin(PROJECT_A));

    const snapshot = supervisor.snapshot();
    expect(snapshot.attempt).toEqual({
      ref: { runtimeEpoch: 'epoch-236', generation: 1 },
      projectKey: PROJECT_A,
      state: 'starting',
    });
    expect(sessionSnapshotSchema.parse(snapshot)).toBeTruthy();
    expect(sessionLabel(snapshot)).toBe('starting');

    runOf(control, 1).settleReady();
    await attempt.ready;
    // readiness is private: the attempt stays starting, nothing else appears
    const afterReady = supervisor.snapshot();
    expect(afterReady.attempt?.state).toBe('starting');
    expect(afterReady.active).toBeUndefined();
    expect(sessionLabel(afterReady)).toBe('starting');
  });

  it('a committed activation reports active {ready} and clears the attempt', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();

    const snapshot = supervisor.snapshot();
    expect(snapshot.active).toEqual({
      ref: { runtimeEpoch: 'epoch-236', generation: 1 },
      projectKey: PROJECT_A,
      state: 'ready',
    });
    expect(snapshot.attempt).toBeUndefined();
    expect(sessionSnapshotSchema.parse(snapshot)).toBeTruthy();
    expect(sessionLabel(snapshot)).toBe('ready');
  });

  it('a failed attempt with no old session reports lastFailure and reads failed', async () => {
    const { supervisor, control } = fixture();
    const attempt = begunOf(supervisor.begin(PROJECT_A));
    runOf(control, 1).failReady('startup-timeout');
    await rejectionOf(attempt.ready);
    await attempt.closed;

    const snapshot = supervisor.snapshot();
    expect(snapshot.active).toBeUndefined();
    expect(snapshot.attempt).toBeUndefined();
    expect(snapshot.lastFailure).toEqual({
      category: 'startup-timeout',
      message: FAILURE_MESSAGES['startup-timeout'],
    });
    expect(sessionSnapshotSchema.parse(snapshot)).toBeTruthy();
    expect(sessionLabel(snapshot)).toBe('failed');
  });

  it('a staged-candidate failure while an old project is ready is a notification, not the global state (ADR-0006 §4)', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();

    const second = begunOf(supervisor.begin(PROJECT_B));
    runOf(control, 2).failReady('worker-crash');
    await rejectionOf(second.ready);
    await second.closed;

    const snapshot = supervisor.snapshot();
    // the OLD session is untouched and still ready — the failure rides beside it
    expect(snapshot.active?.ref.generation).toBe(1);
    expect(snapshot.active?.state).toBe('ready');
    expect(snapshot.attempt).toBeUndefined();
    expect(snapshot.lastFailure?.category).toBe('crash');
    expect(sessionLabel(snapshot)).toBe('ready');
    expect(runOf(control, 1).stopCalls).toBe(0);
  });
});

describe('generation reservation — every attempt consumes one', () => {
  it('reserves successive generations across committed, failed, and cancelled attempts', async () => {
    const { supervisor, control } = fixture();

    const first = begunOf(supervisor.begin(PROJECT_A));
    expect(first.ref).toEqual({ runtimeEpoch: 'epoch-236', generation: 1 });
    runOf(control, 1).failReady('proxy-health');
    await rejectionOf(first.ready);
    await first.closed;

    const second = begunOf(supervisor.begin(PROJECT_A));
    expect(second.ref.generation).toBe(2); // the failed attempt's generation is spent
    runOf(control, 2).settleReady();
    await (await second.ready).commit();

    const third = begunOf(supervisor.begin(PROJECT_B));
    expect(third.ref.generation).toBe(3);
    const cancelling = third.cancel('user');
    runOf(control, 3).closeWith(completeReport('cancelled'));
    await cancelling;
    await third.closed;

    const fourth = begunOf(supervisor.begin(PROJECT_B));
    expect(fourth.ref.generation).toBe(4); // the cancelled one's too
  });

  it('refuses a concurrent activation with the protocol 409 shape', async () => {
    const { supervisor, control } = fixture();
    const first = begunOf(supervisor.begin(PROJECT_A));

    const second = supervisor.begin(PROJECT_B);
    expect(second).toEqual({ kind: 'refused', reason: 'concurrent-activation' });
    // the transport truth: the protocol maps this refusal to HTTP 409 (read-only table)
    expect(ERROR_HTTP_STATUS['concurrent-activation']).toBe(409);
    // and the refused begin started nothing
    expect(control.requests).toHaveLength(1);
    expect(runOf(control, 1).stopCalls).toBe(0);

    // once the attempt ends, begin is admissible again
    runOf(control, 1).failReady('launch-failed');
    await rejectionOf(first.ready);
    await first.closed;
    expect(begunOf(supervisor.begin(PROJECT_B)).ref.generation).toBe(2);
  });
});

describe('the same-root admission — one active plane per root (#420)', () => {
  it('refuses a begin for the ACTIVE session’s root: no second plane, no generation spent, nothing started', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();
    const before = supervisor.snapshot();

    const refused = supervisor.begin(PROJECT_A);
    expect(refused).toEqual({ kind: 'refused', reason: 'same-root-active' });
    // the refused begin is a pure refusal: no candidate started, the
    // committed session untouched, and no generation consumed — the next
    // ADMITTED attempt still takes the very next generation
    expect(control.requests).toHaveLength(1);
    expect(supervisor.snapshot()).toEqual(before);
    expect(begunOf(supervisor.begin(PROJECT_B)).ref.generation).toBe(2);
  });

  it('refuses a begin for the IN-FLIGHT attempt’s root with the same classified reason — the structural law outranks the concurrent one', async () => {
    const { supervisor, control } = fixture();
    const first = begunOf(supervisor.begin(PROJECT_A)); // nothing active: the first plane for A is staging

    // same root, attempt in flight: both admission laws trip; the
    // specific one names the truth — the root already holds its (staging)
    // plane, which is exactly the second-plane shape, not merely a busy machine
    expect(supervisor.begin(PROJECT_A)).toEqual({
      kind: 'refused',
      reason: 'same-root-active',
    });
    // a DIFFERENT root under the same in-flight attempt keeps the
    // pre-existing law and its reason unchanged
    expect(supervisor.begin(PROJECT_B)).toEqual({
      kind: 'refused',
      reason: 'concurrent-activation',
    });
    // still a pure refusal on both counts
    expect(control.requests).toHaveLength(1);
    expect(runOf(control, 1).stopCalls).toBe(0);

    // the attempt ends and the refusal lifts with it: the root is free again
    runOf(control, 1).failReady('launch-failed');
    await rejectionOf(first.ready);
    await first.closed;
    expect(begunOf(supervisor.begin(PROJECT_A)).ref.generation).toBe(2);
  });

  it('a different root proceeds — the staged switch onto another root is the lawful path', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();

    const second = supervisor.begin(PROJECT_B);
    expect(second.kind).toBe('begun');
    expect(control.requests).toHaveLength(2);
    expect(control.requests[1]?.projectKey).toBe(PROJECT_B);
    expect(supervisor.snapshot().active?.projectKey).toBe(PROJECT_A); // the old session stays authoritative
  });

  it('the drain-window shape: the refusal keys on the active truth and holds until the deactivation-side clear — the belt’s 200 is what the client sees mid-drain', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();

    // THE DISCLOSURE (#420 ruling bullet 4, K2’s contract note): during a
    // deactivation drain the active truth is STILL SET here — the
    // supervisor learns the linearized deactivation only through
    // revoke('deactivation') — so the seam-level answer for the draining
    // root is the structural refusal through the whole window. Through
    // the composition this activate never reaches begin: the #413 belt
    // re-reads the same active truth and answers the point-in-time-honest
    // idempotent 200 first. This refusal is the defense-in-depth for
    // races that bypass the belt — its truth runs one transition behind
    // during drains, by the ruling’s own disclosure.
    expect(supervisor.begin(PROJECT_A)).toEqual({
      kind: 'refused',
      reason: 'same-root-active',
    });

    // the deactivation-side clear empties the active entry, and with it
    // the root’s one plane — the explicit deactivate-then-activate the
    // launcher drives is admissible again, fresh generation and all
    const revoked = await supervisor.revoke('deactivation');
    expect(revoked).toEqual({ kind: 'revoked', revoked: first.attempt.ref });
    expect(begunOf(supervisor.begin(PROJECT_A)).ref.generation).toBe(2);
  });
});

describe('private candidate readiness — the old session stays authoritative', () => {
  it('the candidate run starts at begin and readies while the old session is untouched', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();

    const second = begunOf(supervisor.begin(PROJECT_B));
    expect(control.requests).toHaveLength(2);
    expect(control.requests[1]).toEqual({
      projectKey: PROJECT_B,
      sessionRef: { runtimeEpoch: 'epoch-236', generation: 2 },
    });

    // mid-candidate: the OLD session is still the active one, never stopped
    expect(supervisor.snapshot().active?.ref.generation).toBe(1);
    expect(runOf(control, 1).stopCalls).toBe(0);

    runOf(control, 2).settleReady();
    const candidate = await second.ready;
    expect(candidate.ref).toEqual({ runtimeEpoch: 'epoch-236', generation: 2 });

    // even readiness-completed, the candidate is NOT active yet
    expect(supervisor.snapshot().active?.ref.generation).toBe(1);
    expect(runOf(control, 1).stopCalls).toBe(0);
  });
});

describe('failure before commit — rollback preserves the old ready session', () => {
  it('a readiness failure rejects sanitized, stops the candidate, and leaves the old session untouched', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();

    const second = begunOf(supervisor.begin(PROJECT_B));
    runOf(control, 2).failReady('managed-astro-crash');

    const error = await rejectionOf(second.ready);
    if (!(error instanceof ActivationFailedError)) {
      throw new Error(`expected ActivationFailedError, observed: ${String(error)}`);
    }
    expect(error.failure).toEqual({ category: 'crash', message: FAILURE_MESSAGES.crash });
    // the candidate was stopped (the rollback discipline); the old run was not
    expect(runOf(control, 2).stopCalls).toBe(1);
    expect(runOf(control, 1).stopCalls).toBe(0);

    const outcome = await second.closed;
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.failure.category).toBe('crash');
      expect(outcome.report.outcome).toBe('complete');
    }
    expect(supervisor.snapshot().active?.ref.generation).toBe(1);
  });

  it('a raw (unsanitized) startup error maps to the unknown category and never surfaces its text', async () => {
    const { supervisor, control } = fixture();
    const attempt = begunOf(supervisor.begin(PROJECT_A));
    runOf(control, 1).failReadyRaw(HOSTILE);

    const error = await rejectionOf(attempt.ready);
    if (!(error instanceof ActivationFailedError)) {
      throw new Error('expected ActivationFailedError');
    }
    expect(error.failure.category).toBe('unknown');
    expect(error.failure.message).toBe(FAILURE_MESSAGES.unknown);
    expect(error.message).not.toContain('/Users/secret');
    expect(findDisclosure(error.message)).toBeNull();

    const snapshot = supervisor.snapshot();
    expect(snapshot.lastFailure?.category).toBe('unknown');
    expect(findDisclosure(JSON.stringify(snapshot))).toBeNull();
  });

  it('an explicit rollback discards the readiness-completed candidate and records the drain reason', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();
    const second = await staged(supervisor, control, PROJECT_B);

    const rolling = second.candidate.rollback('drain-conflict');
    runOf(control, 2).closeWith(completeReport('stopped'));
    const report = await rolling;
    expect(report.reason).toBe('stopped');

    expect(runOf(control, 1).stopCalls).toBe(0); // the old session was preserved
    const snapshot = supervisor.snapshot();
    expect(snapshot.active?.ref.generation).toBe(1);
    expect(snapshot.lastFailure).toEqual({
      category: 'drain-conflict',
      message: FAILURE_MESSAGES['drain-conflict'],
    });
    const outcome = await second.attempt.closed;
    expect(outcome).toMatchObject({ kind: 'rolled-back', reason: 'drain-conflict' });
  });
});

describe('cancellation', () => {
  it('cancel during startup stops the candidate, records no failure, and spends the generation', async () => {
    const { supervisor, control } = fixture();
    const attempt = begunOf(supervisor.begin(PROJECT_A));

    const cancelling = attempt.cancel('user');
    runOf(control, 1).closeWith(completeReport('cancelled'));
    const report = await cancelling;
    expect(report.reason).toBe('cancelled');
    expect(runOf(control, 1).stopCalls).toBe(1);

    const outcome = await attempt.closed;
    expect(outcome).toMatchObject({ kind: 'cancelled' });
    const snapshot = supervisor.snapshot();
    expect(snapshot.attempt).toBeUndefined();
    expect(snapshot.lastFailure).toBeUndefined(); // a cancel is not a failure
    expect(sessionLabel(snapshot)).toBe('idle');

    // the generation is spent; the next attempt is a fresh one
    expect(begunOf(supervisor.begin(PROJECT_A)).ref.generation).toBe(2);
  });

  it('cancel rejects the pending readiness as the run observes the stop', async () => {
    const { supervisor, control } = fixture();
    const attempt = begunOf(supervisor.begin(PROJECT_A));

    const cancelling = attempt.cancel('shutdown');
    const error = await rejectionOf(attempt.ready);
    expect(error).toBeInstanceOf(Error); // the facade's sanitized cancelled boot error
    runOf(control, 1).closeWith(completeReport('cancelled'));
    await cancelling;
  });

  it('cancel after readiness is the rollback path: candidate discarded, no failure recorded', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();
    const second = await staged(supervisor, control, PROJECT_B);

    const cancelling = second.attempt.cancel('user');
    runOf(control, 2).closeWith(completeReport('cancelled'));
    await cancelling;
    const outcome = await second.attempt.closed;
    expect(outcome).toMatchObject({ kind: 'rolled-back', reason: 'cancelled' });
    const snapshot = supervisor.snapshot();
    expect(snapshot.active?.ref.generation).toBe(1);
    expect(snapshot.lastFailure).toBeUndefined();
    expect(runOf(control, 1).stopCalls).toBe(0);
  });

  it('cancel after any terminal outcome refuses structured', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();

    // a different root: the same-root shape is refused at admission now
    // (#420), so the settled-then-cancel leg rides a lawful A→B switch
    const settled = await staged(supervisor, control, PROJECT_B); // generation 2
    await settled.candidate.commit();
    const refused = await rejectionOf(settled.attempt.cancel('user'));
    if (refused instanceof StageRejectedError) {
      expect(refused.code).toBe('settled');
    } else {
      throw new Error('expected StageRejectedError');
    }
  });
});

describe('the commit linearization', () => {
  it('commit installs the candidate as the active ready session and settles closed committed', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    const result = await first.candidate.commit();
    expect(result.committed).toEqual({ runtimeEpoch: 'epoch-236', generation: 1 });
    const outcome = await first.attempt.closed;
    expect(outcome).toMatchObject({ kind: 'committed', ref: { generation: 1 } });
    expect(supervisor.snapshot().active?.ref.generation).toBe(1);
  });

  it('the committing phase is observable, then the swap completes it', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    const states: string[] = [];
    supervisor.subscribe((snapshot) => {
      states.push(snapshot.attempt?.state ?? 'none');
    });
    await first.candidate.commit();
    expect(states).toEqual(['committing', 'none']);
  });

  it('commit stops the outgoing run and replaces authority: the old session never returns', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();
    const second = await staged(supervisor, control, PROJECT_B);

    expect(runOf(control, 1).stopCalls).toBe(0); // nothing stopped before the commit
    await second.candidate.commit();
    expect(runOf(control, 1).stopCalls).toBe(1); // the outgoing run's stop began at the swap

    const snapshot = supervisor.snapshot();
    expect(snapshot.active).toEqual({
      ref: { runtimeEpoch: 'epoch-236', generation: 2 },
      projectKey: PROJECT_B,
      state: 'ready',
    });

    // a double commit on the spent attempt refuses structured
    const refused = await rejectionOf(second.candidate.commit());
    if (refused instanceof StageRejectedError) {
      expect(refused.code).toBe('settled');
    } else {
      throw new Error('expected StageRejectedError');
    }

    // the outgoing run's late close is history: no failure is invented
    runOf(control, 1).closeWith(completeReport('worker-crash'));
    await flush();
    expect(supervisor.snapshot().lastFailure).toBeUndefined();
    expect(supervisor.snapshot().active?.ref.generation).toBe(2);
  });

  it('no commit can even be expressed before the staged candidate exists; after readiness it is lawful', async () => {
    const { supervisor, control } = fixture();
    const attempt = begunOf(supervisor.begin(PROJECT_A));

    // Readiness has not settled: the staged surface does not exist yet, so
    // nothing is committable (observation only — the promise stays pending).
    const commitTry = attempt.ready.then((candidate) => candidate.commit());
    expect(await settlementOf(commitTry)).toBe('pending');

    runOf(control, 1).settleReady();
    const committed = await commitTry;
    expect(committed.committed.generation).toBe(1);
  });
});

describe('crash observation — no automatic restart, ever', () => {
  it('an active run closing unsupervised clears the session and records a sanitized crash', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();

    runOf(control, 1).closeWith(completeReport('worker-crash'));
    await flush();

    const snapshot = supervisor.snapshot();
    expect(snapshot.active).toBeUndefined();
    expect(snapshot.lastFailure).toEqual({ category: 'crash', message: FAILURE_MESSAGES.crash });
    expect(sessionLabel(snapshot)).toBe('failed');
    // no automatic restart: nothing else was started
    expect(control.requests).toHaveLength(1);
  });

  it('after a crash an explicit begin is admissible — the retry is the host\u2019s call', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();
    runOf(control, 1).closeWith(completeReport('managed-astro-crash'));
    await flush();

    expect(begunOf(supervisor.begin(PROJECT_A)).ref.generation).toBe(2);
  });
});
describe('authority retirement — authority never outlives its session', () => {
  /** The document the retirement legs bind at (distinct per webContents). */
  const doc = (webContentsId: number): ClientDocument => ({ webContentsId, navigationId: 1 });

  /** A supervisor wired with observable grants + clients — the retirement legs' fixture. */
  function wired() {
    const control = candidateRuntime();
    const grants = createHostCapabilityGrants();
    const clients = createSessionClients();
    const supervisor = createSessionSupervisor({
      startCandidate: control.startCandidate,
      runtimeEpoch: 'epoch-236',
      hostCapabilities: grants,
      clients,
    });
    return { supervisor, control, grants, clients };
  }

  /** Binds one diagnostic at a reference — the editor cap belongs to the active-session legs. */
  function bindDiagnostic(
    clients: ReturnType<typeof createSessionClients>,
    document: ClientDocument,
    sessionRef: ActivationAttempt['ref'],
  ): string {
    const bound = clients.bind({ role: 'diagnostic', document, sessionRef });
    if (bound.kind !== 'bound') throw new Error(`expected the diagnostic binding: ${bound.reason}`);
    return bound.capability;
  }

  it('a default-constructed supervisor runs the full cycle on its private grants + clients defaults', async () => {
    // The options doc promises private defaults; this leg pins that the
    // default path is real — the linearization mints and revokes through a
    // default-constructed table without breaking the cycle.
    const control = candidateRuntime();
    const supervisor = createSessionSupervisor({
      startCandidate: control.startCandidate,
      runtimeEpoch: 'epoch-236',
    });
    const first = await staged(supervisor, control);
    await first.candidate.commit();
    const second = await staged(supervisor, control, PROJECT_B);
    await second.candidate.commit();
    expect(supervisor.snapshot().active).toEqual({
      ref: { runtimeEpoch: 'epoch-236', generation: 2 },
      projectKey: PROJECT_B,
      state: 'ready',
    });
  });

  it('a crashed active session takes its client bindings and its host capability with it', async () => {
    const wired_ = wired();
    const first = await staged(wired_.supervisor, wired_.control);
    await first.candidate.commit();
    const ref1 = first.attempt.ref;

    const editor = wired_.clients.bind({ role: 'editor', document: doc(7), sessionRef: ref1 });
    if (editor.kind !== 'bound') throw new Error('unreachable');
    const cookie = wired_.grants.current({ host: 'project', projectKey: PROJECT_A });
    if (cookie === null) throw new Error('expected the commit to mint a capability');
    // pre-crash: both live
    expect(
      wired_.clients.authorize({
        capability: editor.capability,
        document: doc(7),
        sessionRef: ref1,
      }),
    ).toEqual({ kind: 'authorized', role: 'editor' });

    runOf(wired_.control, 1).closeWith(completeReport('worker-crash'));
    await flush();

    expect(wired_.supervisor.snapshot().active).toBeUndefined();
    expect(
      wired_.clients.authorize({
        capability: editor.capability,
        document: doc(7),
        sessionRef: ref1,
      }),
    ).toEqual({ kind: 'rejected', reason: 'no-binding' });
    expect(wired_.grants.verify(cookie, { host: 'project', projectKey: PROJECT_A })).toBe(false);
  });

  it('an attempt that fails without committing retires its reference\u2019s bindings — and only those', async () => {
    const wired_ = wired();
    const first = await staged(wired_.supervisor, wired_.control);
    await first.candidate.commit();
    const editor = wired_.clients.bind({
      role: 'editor',
      document: doc(7),
      sessionRef: first.attempt.ref,
    });
    if (editor.kind !== 'bound') throw new Error('unreachable');

    const second = begunOf(wired_.supervisor.begin(PROJECT_B));
    const candidateBinding = bindDiagnostic(wired_.clients, doc(8), second.ref);
    expect(
      wired_.clients.authorize({
        capability: candidateBinding,
        document: doc(8),
        sessionRef: second.ref,
      }).kind,
    ).toBe('authorized');

    runOf(wired_.control, 2).failReady('worker-crash');
    await rejectionOf(second.ready);
    await second.closed;

    // the dead candidate reference's binding refuses…
    expect(
      wired_.clients.authorize({
        capability: candidateBinding,
        document: doc(8),
        sessionRef: second.ref,
      }),
    ).toEqual({ kind: 'rejected', reason: 'no-binding' });
    // …while the still-active session's editor is untouched
    expect(
      wired_.clients.authorize({
        capability: editor.capability,
        document: doc(7),
        sessionRef: first.attempt.ref,
      }),
    ).toEqual({ kind: 'authorized', role: 'editor' });
  });

  it('a rolled-back candidate retires its reference\u2019s bindings', async () => {
    const wired_ = wired();
    const first = await staged(wired_.supervisor, wired_.control);
    await first.candidate.commit();

    const second = await staged(wired_.supervisor, wired_.control, PROJECT_B);
    const candidateBinding = bindDiagnostic(wired_.clients, doc(8), second.attempt.ref);

    const rolling = second.candidate.rollback('drain-timeout');
    runOf(wired_.control, 2).closeWith(completeReport('stopped'));
    await rolling;

    expect(
      wired_.clients.authorize({
        capability: candidateBinding,
        document: doc(8),
        sessionRef: second.attempt.ref,
      }),
    ).toEqual({ kind: 'rejected', reason: 'no-binding' });
  });

  it('a cancelled attempt retires its reference\u2019s bindings the same way', async () => {
    const wired_ = wired();
    const first = await staged(wired_.supervisor, wired_.control);
    await first.candidate.commit();

    const second = begunOf(wired_.supervisor.begin(PROJECT_B));
    const candidateBinding = bindDiagnostic(wired_.clients, doc(8), second.ref);
    const cancelling = second.cancel('user');
    runOf(wired_.control, 2).closeWith(completeReport('cancelled'));
    await cancelling;

    expect(
      wired_.clients.authorize({
        capability: candidateBinding,
        document: doc(8),
        sessionRef: second.ref,
      }),
    ).toEqual({ kind: 'rejected', reason: 'no-binding' });
  });
});

describe('defensive convergence — misbehaving runs and disowned candidates', () => {
  /** A run whose stop() always rejects with hostile text — the convergence belt's adversary. */
  function rejectingStopRun(): ProjectRun {
    return {
      ready: Promise.resolve(),
      inspect: () => Promise.reject(new StageRejectedError('settled')),
      subscribe: () => () => {},
      stop: () => Promise.reject(new Error('stop exploded at /Users/secret/root (pid 4242)')),
      closed: new Promise<SupervisionCloseReport>(() => {}),
    };
  }

  /** Hooks that answer every callback without supervisor state — the attempt machine alone. */
  const bareHooks = {
    commitCandidate: () => true,
    attemptEnded: () => {},
  } satisfies AttemptHooks;

  it('a rejecting stop converges to the never-spawned report: rollback answers it, closed settles, nothing unhandled', async () => {
    const attempt = createActivationAttempt({
      ref: { runtimeEpoch: 'epoch-236', generation: 1 },
      run: rejectingStopRun(),
      hooks: bareHooks,
    });
    const candidate = await attempt.ready;

    const report = await candidate.rollback('drain-conflict');
    expect(report).toEqual(neverSpawnedReport());
    expect(report).toMatchObject({ reason: 'cancelled', outcome: 'complete' });
    const outcome = await attempt.closed;
    expect(outcome).toEqual({
      kind: 'rolled-back',
      reason: 'drain-conflict',
      report: neverSpawnedReport(),
    });
  });

  it('the cancel paths share the same convergence — a rejecting stop never hangs closed', async () => {
    const attempt = createActivationAttempt({
      ref: { runtimeEpoch: 'epoch-236', generation: 1 },
      run: rejectingStopRun(),
      hooks: bareHooks,
    });
    // cancel before any readiness microtask runs: the starting branch
    const cancelling = attempt.cancel('user');
    const report = await cancelling;
    expect(report).toEqual(neverSpawnedReport());
    const outcome = await attempt.closed;
    expect(outcome).toEqual({ kind: 'cancelled', report: neverSpawnedReport() });

    // and the staged branch: readiness settled first, cancel IS the rollback path
    const second = createActivationAttempt({
      ref: { runtimeEpoch: 'epoch-236', generation: 2 },
      run: rejectingStopRun(),
      hooks: bareHooks,
    });
    await second.ready; // the staged candidate exists; cancelling it is the rollback path
    const cancelled = await second.cancel('user');
    expect(cancelled).toEqual(neverSpawnedReport());
    const secondOutcome = await second.closed;
    expect(secondOutcome).toEqual({
      kind: 'rolled-back',
      reason: 'cancelled',
      report: neverSpawnedReport(),
    });
  });

  it('a rejected close observation still converges to the crash retirement — nothing hangs, nothing unhandled', async () => {
    let rejectClosed: (error: Error) => void = () => {};
    const closed = new Promise<SupervisionCloseReport>((_, reject) => {
      rejectClosed = reject;
    });
    const run: ProjectRun = {
      ready: Promise.resolve(),
      inspect: () => Promise.reject(new StageRejectedError('settled')),
      subscribe: () => () => {},
      stop: () => closed,
      closed,
    };
    const supervisor = createSessionSupervisor({
      startCandidate: () => run,
      runtimeEpoch: 'epoch-236',
    });

    const begun = supervisor.begin(PROJECT_A);
    if (begun.kind !== 'begun') throw new Error('unreachable');
    const candidate = await begun.attempt.ready;
    await candidate.commit();
    expect(supervisor.snapshot().active?.ref.generation).toBe(1);

    // the observer is attached; a REJECTED close is still a crash
    rejectClosed(new Error('closed exploded at /Users/secret/root (pid 4242)'));
    await flush();

    const snapshot = supervisor.snapshot();
    expect(snapshot.active).toBeUndefined();
    expect(snapshot.lastFailure).toEqual({ category: 'crash', message: FAILURE_MESSAGES.crash });
    expect(findDisclosure(JSON.stringify(snapshot))).toBeNull();
  });

  it('a supervisor that disowns the candidate gets a loud structured refusal, never a false success', async () => {
    const run = fakeRun();
    run.settleReady();
    const attempt = createActivationAttempt({
      ref: { runtimeEpoch: 'epoch-236', generation: 1 },
      run: run.run,
      hooks: {
        ...bareHooks,
        commitCandidate: () => false, // the divergence: the supervisor no longer holds this attempt
      },
    });
    const candidate = await attempt.ready;

    const refusal = await rejectionOf(candidate.commit());
    if (!(refusal instanceof StageRejectedError)) {
      throw new Error(`expected StageRejectedError, observed: ${String(refusal)}`);
    }
    expect(refusal.code).toBe('not-current');

    // the attempt is spent and closed converges — nothing hangs; the orphaned run was stopped
    const outcome = await attempt.closed;
    expect(outcome).toEqual({ kind: 'cancelled', report: neverSpawnedReport() });
    expect(run.stopCalls).toBe(1);

    const again = await rejectionOf(candidate.rollback('drain-conflict'));
    if (!(again instanceof StageRejectedError)) throw new Error('expected StageRejectedError');
    expect(again.code).toBe('settled');
  });
});

describe('subscribe — snapshot notifications', () => {
  it('notifies begin and failure; unbind stops delivery; a throwing listener breaks nothing', async () => {
    const { supervisor, control } = fixture();
    const frames: unknown[] = [];
    const unbind = supervisor.subscribe((snapshot) => frames.push(snapshot));
    supervisor.subscribe(() => {
      throw new Error('subscriber bug');
    });

    const attempt = begunOf(supervisor.begin(PROJECT_A));
    expect(frames).toHaveLength(1);
    runOf(control, 1).failReady('proxy-health');
    await rejectionOf(attempt.ready);
    await attempt.closed;
    expect(frames).toHaveLength(2);

    unbind();
    runOf(control, 1).closeWith(completeReport('worker-crash'));
    await flush();
    expect(frames).toHaveLength(2); // unbound: the crash frame went only to the throwing one
  });
});

describe('output hygiene — every failure this surface can produce', () => {
  it('every fixed failure message is disclosure-free', () => {
    for (const message of Object.values(FAILURE_MESSAGES)) {
      expect(findDisclosure(message)).toBeNull();
      expect(message).not.toContain('/Users');
      expect(message).not.toContain('9999');
    }
  });

  it('a throwing startCandidate seam still fails sanitized with its generation spent', async () => {
    const control = candidateRuntime();
    const supervisor = createSessionSupervisor({
      startCandidate: control.startCandidate,
      runtimeEpoch: 'epoch-236',
    });
    control.failNextStart = true;

    const attempt = begunOf(supervisor.begin(PROJECT_A));
    const error = await rejectionOf(attempt.ready);
    if (!(error instanceof ActivationFailedError)) {
      throw new Error('expected ActivationFailedError');
    }
    expect(error.failure.category).toBe('startup');
    expect(error.message).not.toContain('/Users/secret');

    const outcome = await attempt.closed;
    expect(outcome.kind).toBe('failed');
    expect(supervisor.snapshot().lastFailure?.category).toBe('startup');
    // the generation is spent
    expect(begunOf(supervisor.begin(PROJECT_A)).ref.generation).toBe(2);
  });
});
