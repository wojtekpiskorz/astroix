import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import type { SwitchPreparationInput } from '../../session-supervisor/commit/switch-coordinator.ts';
import { createSwitchCoordinator } from '../../session-supervisor/commit/switch-coordinator.ts';
import type { SwitchPreparationReceipt } from '../../session-supervisor/commit/switch-receipt.ts';
import type { EditDrain } from '../../session-supervisor/fence/edit-fence.ts';
import type { RevocationStep } from '../../session-supervisor/revocation/authority-revocation.ts';
import type { StagedCandidate } from '../../session-supervisor/staging/session-supervisor.ts';
import {
  activateFirst,
  beginCandidate,
  commitFixture,
  completeReport,
  drainClean,
  EDITOR_DOC,
  fakeExecutor,
  flushMicrotasks,
  hangingEdit,
  manualClock,
  PROJECT_A,
  PROJECT_B,
  type Release,
  type SessionSeat,
  sameRef,
  switchTo,
} from './commit-harness.ts';

/**
 * The #238 focused tests, part 3 — the commit linearization
 * (ADR-0006 §4 step 5): receipt consumption is the irreversible point;
 * the ordered revocation of every old-side surface runs BEFORE the
 * candidate grant (the journal observes each revocation entry point
 * before the mint F4's supervisor performs inside the paramless
 * commit); a rejected binding refuses without spending the receipt;
 * a replay refuses sanitized; a grant that fails after revocation is
 * the irreversible `failed` result; and the deactivation variant runs
 * the same revocation order with no grant at all.
 */

/** The journal marks of the five old-side revocation steps — each must precede the grant's mint. */
const REVOCATION_MARKS = [
  'streams:endForBinding',
  'streams:endForHost',
  'streams:endForSession',
  'routes:revoke',
  'edit-grants:revokeSession',
  'clients:revokeSession',
  'http-bindings:unbind',
  'host-capability:revoke',
] as const;

/** A staged-candidate stand-in for the binding checks — its commit must never run on a refused path. */
function stubCandidate(ref: SessionRef, committed: { ran: boolean }): StagedCandidate {
  return {
    ref,
    commit: () => {
      committed.ran = true;
      return Promise.resolve({ committed: ref });
    },
    rollback: () => Promise.resolve(completeReport('stopped')),
  };
}

/** The prepared switch the shared prologue hands back: the seat, the candidate (replacements), the mint input, the receipt. */
interface PreparedSwitch {
  readonly first: SessionSeat;
  readonly candidate: StagedCandidate | null;
  readonly base: SwitchPreparationInput;
  readonly receipt: SwitchPreparationReceipt;
}

/**
 * The linearization legs' shared prologue (the neighboring
 * `deactivationBase` idiom): activate A, drain it clean, begin the B
 * candidate for replacements, and mint the receipt over the drained
 * session. Each leg then varies exactly one variable around the spend.
 */
async function preparedSwitch(
  fx: ReturnType<typeof commitFixture>,
  tail:
    | { readonly kind: 'replacement' }
    | { readonly kind: 'deactivation'; readonly stopOldRun: () => void },
): Promise<PreparedSwitch> {
  const first = await activateFirst(fx, PROJECT_A);
  const drain = await drainClean(first);
  const candidate = tail.kind === 'replacement' ? await beginCandidate(fx, PROJECT_B) : null;
  const base: SwitchPreparationInput = {
    oldSession: first.ref,
    target:
      candidate !== null
        ? { kind: 'replacement', candidate: candidate.ref }
        : { kind: 'deactivation' },
    client: first.client,
    fence: first.fence,
    drain,
    host: { host: 'project', projectKey: PROJECT_A },
    routes: first.lease,
    stopOldRun: tail.kind === 'deactivation' ? tail.stopOldRun : undefined,
  };
  const prepared = await fx.coordinator.prepareNormal(base);
  if (prepared.kind !== 'prepared') {
    throw new Error(`expected a prepared receipt, refused: ${prepared.reason}`);
  }
  return { first, candidate, base, receipt: prepared.receipt };
}

/** The replacement legs' narrowing guard — a replacement prologue always carries its candidate. */
function candidateOf(prepared: PreparedSwitch): StagedCandidate {
  if (prepared.candidate === null) throw new Error('expected the replacement candidate');
  return prepared.candidate;
}

/** The forced-spend prologue's hand-back: the seat, the candidate, the receipt, the stuck write's release, the timed-out drain. */
interface ForcedPrepared {
  readonly first: SessionSeat;
  readonly candidate: StagedCandidate;
  readonly receipt: SwitchPreparationReceipt;
  readonly release: Release;
  readonly drain: EditDrain;
}

/**
 * The forced-spend legs' shared prologue: the old session's drain times
 * out with one stuck accepted write, the executor's exit is observed,
 * and the FORCED receipt mints over the replacement target — the arm
 * the composition takes when the session is already in trouble.
 */
async function forcedPrepared(fx: ReturnType<typeof commitFixture>): Promise<ForcedPrepared> {
  const first = await activateFirst(fx, PROJECT_A);
  const release: Release = { settled: false, resolve: () => {} };
  const started = first.fence.fence(() => [hangingEdit('stuck-write', release)]);
  if (started.kind !== 'fenced') throw new Error('expected the drain to start');
  first.drain = started.drain;
  await flushMicrotasks(); // the queue takes the stuck edit in flight
  first.fenceClock.fireDeadline(); // the five-second bound: the verdict is timed-out
  if (first.fence.state !== 'timed-out') throw new Error('expected the timed-out verdict');

  const candidate = await beginCandidate(fx, PROJECT_B);
  const reap = fakeExecutor();
  const pending = fx.coordinator.prepareForced({
    oldSession: first.ref,
    target: { kind: 'replacement', candidate: candidate.ref },
    client: first.client,
    fence: first.fence,
    drain: started.drain,
    host: { host: 'project', projectKey: PROJECT_A },
    routes: first.lease,
    executor: reap.executor,
  });
  reap.settleExit(null, 'SIGKILL'); // the exit observation arrives
  const prepared = await pending;
  if (prepared.kind !== 'prepared') {
    throw new Error(`expected a forced receipt, refused: ${prepared.kind}`);
  }
  return { first, candidate, receipt: prepared.receipt, release, drain: started.drain };
}

describe('the commit linearization — consumption, ordering, and the grant', () => {
  it('revokes every old-side surface BEFORE granting candidate authority, in the one order', async () => {
    const fx = commitFixture();
    const first = await activateFirst(fx, PROJECT_A);
    fx.liveGrants.set(`${first.ref.runtimeEpoch}#${first.ref.generation}`, 3);
    fx.journal.length = 0; // observe exactly this switch's sequence

    const result = await switchTo(fx, PROJECT_B);

    expect(result.kind).toBe('committed');
    const grantAt = fx.journal.indexOf('grant:mint');
    expect(grantAt).toBeGreaterThanOrEqual(0);
    for (const mark of REVOCATION_MARKS) {
      expect(fx.journal.indexOf(mark), `before the grant: ${mark}`).toBeGreaterThanOrEqual(0);
      expect(fx.journal.indexOf(mark), `${mark} precedes the mint`).toBeLessThan(grantAt);
    }
    // the report's own step order is the same law, recorded
    if (result.kind !== 'committed') throw new Error('unreachable');
    expect(result.revoked.steps.map((step) => step.step)).toEqual<RevocationStep[]>([
      'streams',
      'routes',
      'edit-grants',
      'client-bindings',
      'host-capability',
    ]);
    expect(result.revoked.outcome).toBe('complete');
    const grantsStep = result.revoked.steps[2];
    expect(grantsStep?.result).toEqual({ kind: 'grants-evicted', evicted: 3 });
    expect(sameRef(result.revoked.session, first.ref)).toBe(true);
    // the supervisor's snapshot moved to the committed pair
    expect(sameRef(fx.supervisor.snapshot().active?.ref ?? first.ref, result.committed)).toBe(true);
  });

  it('awaits the lease revocation before the outgoing run stops — the ADR-0005 stop order', async () => {
    const fx = commitFixture();
    await activateFirst(fx, PROJECT_A);
    const oldRun = fx.runs[0];
    if (oldRun === undefined) throw new Error('unreachable');
    fx.journal.length = 0;
    await switchTo(fx, PROJECT_B);
    // the lease revoke precedes the grant — and the old run's stop (the
    // supervisor initiates it inside the same commit) observed after it
    expect(fx.journal.indexOf('routes:revoke')).toBeLessThan(fx.journal.indexOf('grant:mint'));
    expect(oldRun.stopCalls).toBe(1);
  });

  it('a candidate that is not the bound one refuses without spending the receipt or revoking anything', async () => {
    const fx = commitFixture();
    const prepared = await preparedSwitch(fx, { kind: 'replacement' });
    const { first, receipt } = prepared;
    const candidate = candidateOf(prepared);

    // a candidate the receipt never bound: a foreign pair, its commit never called
    const strangerCommitted = { ran: false };
    const stranger = stubCandidate(
      { runtimeEpoch: first.ref.runtimeEpoch, generation: first.ref.generation + 5 },
      strangerCommitted,
    );
    fx.journal.length = 0; // observe only what this commit attempt does
    const rejected = await fx.coordinator.commit(receipt, stranger);
    expect(rejected).toEqual({ kind: 'rejected', reason: 'candidate-mismatch' });
    expect(strangerCommitted.ran).toBe(false);
    // nothing linearized: no revocation ran, old authority intact
    expect(fx.journal).toEqual([]);
    expect(
      fx.capabilityGrants.verify(first.cookie, { host: 'project', projectKey: PROJECT_A }),
    ).toBe(true);
    // the receipt is unspent — the bound candidate still commits with it
    const committed = await fx.coordinator.commit(receipt, candidate);
    expect(committed.kind).toBe('committed');
  });

  it('a consumed receipt never replays — the sanitized refusal, with no second revocation', async () => {
    const fx = commitFixture();
    const prepared = await preparedSwitch(fx, { kind: 'replacement' });
    const candidate = candidateOf(prepared);
    const firstCommit = await fx.coordinator.commit(prepared.receipt, candidate);
    expect(firstCommit.kind).toBe('committed');
    const afterCommit = fx.journal.length;

    const replay = await fx.coordinator.commit(prepared.receipt, candidate);
    expect(replay).toEqual({ kind: 'rejected', reason: 'already-consumed' });
    expect(fx.journal.length).toBe(afterCommit); // no second revocation, no second grant
  });

  it('a receipt another coordinator minted is unknown currency — nothing revokes', async () => {
    const fx = commitFixture();
    const prepared = await preparedSwitch(fx, { kind: 'replacement' });
    const { first, base, receipt } = prepared;
    void receipt; // the fx-minted twin stays unspent — the foreign mint is the variable
    const candidate = candidateOf(prepared);
    const foreign = createSwitchCoordinator({
      clients: fx.clients,
      hostCapabilities: fx.capabilityGrants,
      streams: fx.hub,
      grants: { revokeSession: () => 0 },
      httpBindings: fx.httpBindings,
      reapClock: manualClock().clock,
    });
    const minted = await foreign.prepareNormal(base);
    if (minted.kind !== 'prepared') throw new Error('unreachable');
    fx.journal.length = 0;
    const rejected = await fx.coordinator.commit(minted.receipt, candidate);
    expect(rejected).toEqual({ kind: 'rejected', reason: 'unknown-receipt' });
    expect(fx.journal).toEqual([]);
    expect(
      fx.capabilityGrants.verify(first.cookie, { host: 'project', projectKey: PROJECT_A }),
    ).toBe(true);
  });

  it('a receipt whose fence left its certified state refuses at consumption — unspent, nothing revoked', async () => {
    const fx = commitFixture();
    const prepared = await preparedSwitch(fx, { kind: 'replacement' });
    const { first, receipt } = prepared;
    const candidate = candidateOf(prepared);
    // the fence resumes between mint and consumption: the certification
    // no longer covers the fence's state
    expect(first.drain?.resume()).toEqual({ kind: 'resumed' });
    fx.journal.length = 0;
    const rejected = await fx.coordinator.commit(receipt, candidate);
    expect(rejected).toEqual({ kind: 'rejected', reason: 'fence-resumed' });
    expect(fx.journal).toEqual([]);
    expect(
      fx.capabilityGrants.verify(first.cookie, { host: 'project', projectKey: PROJECT_A }),
    ).toBe(true);
  });

  it('a grant refused after revocation is the irreversible failed result — authority stays revoked', async () => {
    const fx = commitFixture();
    const prepared = await preparedSwitch(fx, { kind: 'replacement' });
    const { first, receipt } = prepared;
    const candidate = candidateOf(prepared);
    // the candidate settles before the commit runs — the grant will refuse
    const candidateRun = fx.runs[1];
    if (candidateRun === undefined) throw new Error('expected the candidate run');
    const rollback = candidate.rollback('cancelled');
    candidateRun.closeWith(completeReport('stopped'));
    await rollback;

    const failed = await fx.coordinator.commit(receipt, candidate);
    expect(failed.kind).toBe('failed');
    if (failed.kind !== 'failed') throw new Error('unreachable');
    expect(failed.failure).toEqual({
      category: 'revocation',
      message: 'the session commit failed after the outgoing authority was revoked',
    });
    expect(failed.revoked.outcome).toBe('complete');
    // irreversibility: the old authority is dead, never resumed
    expect(
      fx.capabilityGrants.verify(first.cookie, { host: 'project', projectKey: PROJECT_A }),
    ).toBe(false);
    expect(first.lease.revocations).toBe(1);
    // and the spent receipt never replays
    const replay = await fx.coordinator.commit(receipt, candidate);
    expect(replay).toEqual({ kind: 'rejected', reason: 'already-consumed' });
  });

  it('an honestly incomplete lease close reports incomplete — the commit stands, the report tells the truth', async () => {
    const fx = commitFixture();
    const first = await activateFirst(fx, PROJECT_A);
    first.lease.setOutcome('incomplete');
    const result = await switchTo(fx, PROJECT_B);
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error('unreachable');
    expect(result.revoked.outcome).toBe('incomplete');
    const routesStep = result.revoked.steps[1];
    expect(routesStep?.result).toEqual({
      kind: 'lease-revoked',
      lease: 'incomplete',
      destroyedSockets: 2,
    });
  });

  it('a throwing revocation surface fails that step, continues the sequence, and still grants', async () => {
    const fx = commitFixture();
    await activateFirst(fx, PROJECT_A);
    fx.failNextGrantRevocation = true;
    const result = await switchTo(fx, PROJECT_B);
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error('unreachable');
    expect(result.revoked.outcome).toBe('incomplete');
    expect(result.revoked.steps[2]?.result).toEqual({ kind: 'failed' });
    // the sequence continued past the failed step — all five steps recorded
    expect(result.revoked.steps.map((step) => step.step)).toHaveLength(5);
    expect(fx.journal).toContain('host-capability:revoke');
    expect(fx.journal).toContain('grant:mint');
  });

  it('spends a forced-minted receipt — the revocation order holds over the forced arm', async () => {
    const fx = commitFixture();
    const forced = await forcedPrepared(fx);
    expect(forced.receipt.preparation.kind).toBe('forced');

    fx.journal.length = 0; // observe exactly this commit's sequence
    const result = await fx.coordinator.commit(forced.receipt, forced.candidate);
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error('unreachable');
    // the same order proof as the normal arm: every old-side revocation
    // precedes the grant's mint, recorded steps in the one order
    const grantAt = fx.journal.indexOf('grant:mint');
    expect(grantAt).toBeGreaterThanOrEqual(0);
    for (const mark of REVOCATION_MARKS) {
      expect(fx.journal.indexOf(mark), `${mark} precedes the mint`).toBeGreaterThanOrEqual(0);
      expect(fx.journal.indexOf(mark), `${mark} precedes the mint`).toBeLessThan(grantAt);
    }
    expect(result.revoked.steps.map((step) => step.step)).toEqual<RevocationStep[]>([
      'streams',
      'routes',
      'edit-grants',
      'client-bindings',
      'host-capability',
    ]);
    // the stuck write's late settlement is history — the forced verdict sealed it
    forced.release.resolve();
    await forced.drain.settled;
    expect(result.revoked.outcome).toBe('complete');
  });

  it('refuses a forced-minted receipt whose fence left the timed-out states — the world moved, nothing revoked', async () => {
    const fx = commitFixture();
    const forced = await forcedPrepared(fx);
    // the world moves after the mint: the stuck write settles
    // (terminal-after-timeout — still a certified state), then the
    // fence resumes — out of the forced arm's certified set entirely
    forced.release.resolve();
    forced.release.settled = true;
    await forced.drain.settled;
    expect(forced.first.fence.state).toBe('terminal-after-timeout');
    expect(forced.drain.resume()).toEqual({ kind: 'resumed' });
    expect(forced.first.fence.state).toBe('open');

    fx.journal.length = 0;
    const rejected = await fx.coordinator.commit(forced.receipt, forced.candidate);
    expect(rejected).toEqual({ kind: 'rejected', reason: 'fence-resumed' });
    expect(fx.journal).toEqual([]); // nothing revoked, nothing granted
    expect(
      fx.capabilityGrants.verify(forced.first.cookie, { host: 'project', projectKey: PROJECT_A }),
    ).toBe(true);
  });
});

describe('the deactivation variant — the same order, no grant', () => {
  it('consumes the receipt, revokes in order, stops the outgoing run after revocation, and grants nothing', async () => {
    const fx = commitFixture();
    let stopped = false;
    const prepared = await preparedSwitch(fx, {
      kind: 'deactivation',
      stopOldRun: () => {
        stopped = true;
        fx.journal.push('stop:old-run');
      },
    });
    const { first, receipt } = prepared;
    fx.liveGrants.set(`${first.ref.runtimeEpoch}#${first.ref.generation}`, 2);
    fx.journal.length = 0; // observe exactly the deactivation's sequence
    const result = await fx.coordinator.deactivate(receipt);

    expect(result.kind).toBe('deactivated');
    if (result.kind !== 'deactivated') throw new Error('unreachable');
    expect(sameRef(result.deactivated, first.ref)).toBe(true);
    // every old-side revocation preceded the outgoing stop; no mint — no grant
    const stopAt = fx.journal.indexOf('stop:old-run');
    for (const mark of REVOCATION_MARKS) {
      expect(fx.journal.indexOf(mark), `${mark} precedes the stop`).toBeLessThan(stopAt);
    }
    expect(fx.journal).not.toContain('grant:mint');
    expect(stopped).toBe(true);
    // old authority is fully dead
    expect(
      fx.capabilityGrants.verify(first.cookie, { host: 'project', projectKey: PROJECT_A }),
    ).toBe(false);
    expect(fx.grantEvictions).toEqual([first.ref]);
    expect(
      fx.clients.authorize({
        capability: first.client.capability,
        document: EDITOR_DOC,
        sessionRef: first.ref,
      }).kind,
    ).toBe('rejected');
  });

  it('refuses a replacement receipt handed to deactivate', async () => {
    const fx = commitFixture();
    const replacement = await preparedSwitch(fx, { kind: 'replacement' });
    const candidate = candidateOf(replacement);
    fx.journal.length = 0;
    const wrongTarget = await fx.coordinator.deactivate(replacement.receipt);
    expect(wrongTarget).toEqual({ kind: 'rejected', reason: 'not-a-deactivation' });
    expect(fx.journal).toEqual([]); // nothing happened, nothing spent
    // the receipt still spends on its own path
    expect((await fx.coordinator.commit(replacement.receipt, candidate)).kind).toBe('committed');
  });

  it('refuses a deactivation receipt handed to commit', async () => {
    const fx = commitFixture();
    const prepared = await preparedSwitch(fx, { kind: 'deactivation', stopOldRun: () => {} });
    const { first, receipt } = prepared;
    const strangerCommitted = { ran: false };
    const anyCandidate = stubCandidate(
      { runtimeEpoch: first.ref.runtimeEpoch, generation: 99 },
      strangerCommitted,
    );
    fx.journal.length = 0;
    const wrongCommit = await fx.coordinator.commit(receipt, anyCandidate);
    expect(wrongCommit).toEqual({ kind: 'rejected', reason: 'not-a-replacement' });
    expect(strangerCommitted.ran).toBe(false);
    expect(fx.journal).toEqual([]);
  });

  it('a deactivated receipt never replays either', async () => {
    const fx = commitFixture();
    const prepared = await preparedSwitch(fx, { kind: 'deactivation', stopOldRun: () => {} });
    expect((await fx.coordinator.deactivate(prepared.receipt)).kind).toBe('deactivated');
    const replay = await fx.coordinator.deactivate(prepared.receipt);
    expect(replay).toEqual({ kind: 'rejected', reason: 'already-consumed' });
  });
});
