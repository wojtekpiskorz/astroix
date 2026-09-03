import {
  findDisclosure,
  sessionLabel,
  sessionSnapshotSchema,
} from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import { createHostCapabilityGrants } from '../../api/http/host-capability.ts';
import { createSessionClients } from '../../session-supervisor/clients/session-clients.ts';
import {
  type ActivationAttempt,
  createSessionSupervisor,
  FAILURE_MESSAGES,
  type SessionSupervisor,
} from '../../session-supervisor/staging/session-supervisor.ts';
import {
  type CandidateRuntimeControl,
  candidateRuntime,
  completeReport,
  type FakeRun,
  flush,
  PROJECT_A,
  rejectionOf,
} from './staging-harness.ts';

/**
 * The #331 focused tests — the deactivation-side clear: `revoke` empties
 * the active session without recording a failure (a genuine crash still
 * does), refuses with `no-active-session` when there is nothing to
 * clear, never stops the run itself (the transition's stop seam owns
 * the stop), and retires authority exactly as the crash path does.
 */

interface Fixture {
  readonly supervisor: SessionSupervisor;
  readonly control: CandidateRuntimeControl;
}

function fixture(epoch = 'epoch-331'): Fixture {
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

describe('the deactivation-side clear — revoke empties active without recording a failure (#331)', () => {
  it('a supervised deactivation clears the snapshot to idle — no failure, no invented fields', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();

    const result = await supervisor.revoke('deactivation');
    expect(result).toEqual({
      kind: 'revoked',
      revoked: { runtimeEpoch: 'epoch-331', generation: 1 },
    });
    expect(findDisclosure(JSON.stringify(result))).toBeNull();

    const snapshot = supervisor.snapshot();
    expect(snapshot).toEqual({});
    expect(sessionSnapshotSchema.parse(snapshot)).toEqual({});
    expect(sessionLabel(snapshot)).toBe('idle');
  });

  it('leaves an earlier lastFailure untouched — the clear records nothing', async () => {
    const { supervisor, control } = fixture();
    const failed = begunOf(supervisor.begin(PROJECT_A));
    runOf(control, 1).failReady('startup-timeout');
    await rejectionOf(failed.ready);
    await failed.closed;

    const second = await staged(supervisor, control);
    await second.candidate.commit();

    await supervisor.revoke('deactivation');
    const snapshot = supervisor.snapshot();
    expect(snapshot.active).toBeUndefined();
    expect(snapshot.attempt).toBeUndefined();
    // the pre-existing failure is preserved verbatim — a deactivation is not one
    expect(snapshot.lastFailure).toEqual({
      category: 'startup-timeout',
      message: FAILURE_MESSAGES['startup-timeout'],
    });
    expect(sessionSnapshotSchema.parse(snapshot)).toBeTruthy();
  });

  it('notifies listeners with the clean snapshot', async () => {
    const { supervisor, control } = fixture();
    const frames: unknown[] = [];
    supervisor.subscribe((snapshot) => frames.push(snapshot));
    const first = await staged(supervisor, control);
    await first.candidate.commit();
    expect(frames).toHaveLength(3); // begin, committing, the swap

    await supervisor.revoke('deactivation');
    expect(frames).toHaveLength(4);
    expect(frames[3]).toEqual({});
  });

  it('the stopped run’s late close is history, not a crash — even under a crash reason', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();
    await supervisor.revoke('deactivation');

    // the transition's stop converges the run; whatever reason the close
    // report carries, the deactivation already owned the clear
    runOf(control, 1).closeWith(completeReport('worker-crash'));
    await flush();

    const snapshot = supervisor.snapshot();
    expect(snapshot).toEqual({});
    expect(sessionLabel(snapshot)).toBe('idle');
  });

  it('a genuine crash still records the failure — the distinction is the point', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();
    await supervisor.revoke('deactivation');

    const second = await staged(supervisor, control);
    await second.candidate.commit();
    runOf(control, 2).closeWith(completeReport('worker-crash'));
    await flush();

    const snapshot = supervisor.snapshot();
    expect(snapshot.active).toBeUndefined();
    expect(snapshot.lastFailure).toEqual({ category: 'crash', message: FAILURE_MESSAGES.crash });
    expect(sessionLabel(snapshot)).toBe('failed');
  });

  it('a replay with no active session answers the sanitized refusal and notifies nothing', async () => {
    const { supervisor } = fixture();
    const frames: unknown[] = [];
    supervisor.subscribe((snapshot) => frames.push(snapshot));

    expect(await supervisor.revoke('deactivation')).toEqual({
      kind: 'refused',
      reason: 'no-active-session',
    });
    expect(supervisor.snapshot()).toEqual({});
    expect(frames).toHaveLength(0);
  });

  it('a second revoke after the clear refuses — the clear is idempotent by refusal', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();
    await supervisor.revoke('deactivation');

    expect(await supervisor.revoke('deactivation')).toEqual({
      kind: 'refused',
      reason: 'no-active-session',
    });
    expect(supervisor.snapshot()).toEqual({});
  });

  it('a revoke after a crash refuses — the crash observation already cleared it', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();
    runOf(control, 1).closeWith(completeReport('worker-crash'));
    await flush();

    expect(await supervisor.revoke('deactivation')).toEqual({
      kind: 'refused',
      reason: 'no-active-session',
    });
    // the crash's own record stands untouched
    expect(supervisor.snapshot().lastFailure).toEqual({
      category: 'crash',
      message: FAILURE_MESSAGES.crash,
    });
  });

  it('an in-flight attempt holds no authority to revoke — its own machine ends it', async () => {
    const { supervisor, control } = fixture();
    const attempt = begunOf(supervisor.begin(PROJECT_A));

    expect(await supervisor.revoke('deactivation')).toEqual({
      kind: 'refused',
      reason: 'no-active-session',
    });

    // the attempt converges through its own paths, failure and all
    runOf(control, 1).failReady('proxy-health');
    await rejectionOf(attempt.ready);
    const outcome = await attempt.closed;
    expect(outcome.kind).toBe('failed');
    expect(supervisor.snapshot().lastFailure?.category).toBe('startup');
  });

  it('the clear never stops the run — the transition’s stop seam owns the stop', async () => {
    const { supervisor, control } = fixture();
    const first = await staged(supervisor, control);
    await first.candidate.commit();

    await supervisor.revoke('deactivation');
    expect(runOf(control, 1).stopCalls).toBe(0);
  });

  it('runs the same authority retirement as a crash: bindings and host capability die with the session', async () => {
    const control = candidateRuntime();
    const grants = createHostCapabilityGrants();
    const clients = createSessionClients();
    const supervisor = createSessionSupervisor({
      startCandidate: control.startCandidate,
      runtimeEpoch: 'epoch-331',
      hostCapabilities: grants,
      clients,
    });
    const first = await staged(supervisor, control);
    await first.candidate.commit();
    const ref1 = first.attempt.ref;

    const editor = clients.bind({
      role: 'editor',
      document: { webContentsId: 7, navigationId: 1 },
      sessionRef: ref1,
    });
    if (editor.kind !== 'bound') throw new Error('unreachable');
    const cookie = grants.current({ host: 'project', projectKey: PROJECT_A });
    if (cookie === null) throw new Error('expected the commit to mint a capability');

    await supervisor.revoke('deactivation');

    expect(supervisor.snapshot().active).toBeUndefined();
    expect(
      clients.authorize({
        capability: editor.capability,
        document: { webContentsId: 7, navigationId: 1 },
        sessionRef: ref1,
      }),
    ).toEqual({ kind: 'rejected', reason: 'no-binding' });
    expect(grants.verify(cookie, { host: 'project', projectKey: PROJECT_A })).toBe(false);
  });
});
