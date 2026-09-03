import { describe, expect, it } from 'vitest';
import { writeRejection } from '../../edit-authority/executor/write-outcomes.ts';
import type { SwitchPreparationInput } from '../../session-supervisor/commit/switch-coordinator.ts';
import type { QueuedEdit } from '../../session-supervisor/fence/edit-fence.ts';
import {
  createEditFence,
  type EditDrain,
  type EditFence,
} from '../../session-supervisor/fence/edit-fence.ts';
import {
  activateFirst,
  beginCandidate,
  commitFixture,
  completeReport,
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
} from './commit-harness.ts';

/**
 * The #238 focused tests, part 2 — receipt issuance (ADR-0006 §4 steps
 * 4–5): the normal variant over the fence's sealed terminal verdict,
 * the forced variant over the OBSERVED exact write-executor exit, the
 * refusals that keep a lying receipt from ever existing, and the
 * incomplete forced reap that creates NO receipt (the composition then
 * rolls the candidate back under F4's `incomplete-reap` reason with old
 * authority untouched — the tombstone and blocked no-active state are
 * the composition's, not this lane's).
 */

/** One queued edit settling with the given terminal outcome (the #237 controlled-edit idiom). */
function settledEdit(key: string, outcome: ReturnType<typeof writeRejection>): QueuedEdit {
  return { key, execute: () => Promise.resolve(outcome) };
}

/** One fence-and-drain pair in the given terminal state. */
interface SealedFence {
  readonly fence: EditFence;
  readonly drain: EditDrain;
  readonly clock: ReturnType<typeof manualClock>;
}

/** An empty fence whose drain already settled `drained` — the normal receipt's precondition. */
async function drainedFence(): Promise<SealedFence> {
  const clock = manualClock();
  const fence = createEditFence({ clock: clock.clock });
  const started = fence.fence();
  if (started.kind !== 'fenced') throw new Error('expected the fence to start');
  await started.drain.outcome;
  return { fence, drain: started.drain, clock };
}

/** A fence with one stuck accepted write, verdict sealed `timed-out` — the force path's precondition. */
async function timedOutFence(): Promise<SealedFence & { readonly release: Release }> {
  const clock = manualClock();
  const fence = createEditFence({ clock: clock.clock });
  const release: Release = { resolve: () => {} };
  const started = fence.fence(() => [hangingEdit('stuck-write', release)]);
  if (started.kind !== 'fenced') throw new Error('expected the fence to start');
  await flushMicrotasks(); // the queue takes the edit in flight
  clock.fireDeadline();
  return { fence, drain: started.drain, clock, release };
}

/** The first activation's committed ref — the old session every mint binds against (no editor seated: the legs bind their own). */
async function firstRef(fx: ReturnType<typeof commitFixture>): Promise<SessionSeat['ref']> {
  const begun = fx.supervisor.begin(PROJECT_A);
  if (begun.kind !== 'begun') throw new Error('expected admission');
  const run = fx.runs[fx.runs.length - 1];
  if (run === undefined) throw new Error('no candidate run');
  run.settleReady();
  const candidate = await begun.attempt.ready;
  const result = await candidate.commit();
  return result.committed;
}

/** Binds the authoritative editor at the pair on both tables — the mint's client input. */
function bindEditor(
  fx: ReturnType<typeof commitFixture>,
  ref: SessionSeat['ref'],
): { document: typeof EDITOR_DOC; capability: string; httpCapability: string } {
  const editor = fx.clients.bind({ role: 'editor', document: EDITOR_DOC, sessionRef: ref });
  const http = fx.httpBindings.bind({ role: 'editor', host: 'project', sessionRef: ref });
  if (editor.kind !== 'bound' || http.kind !== 'bound') throw new Error('expected bindings');
  return { document: EDITOR_DOC, capability: editor.capability, httpCapability: http.capability };
}

describe('the normal preparation — issuance over the sealed terminal drain', () => {
  it('mints over a clean drained fence and binds old pair, candidate, client, fence, and preparation result', async () => {
    const fx = commitFixture();
    const first = await firstRef(fx);
    const sealed = await drainedFence();
    const candidate = await beginCandidate(fx, PROJECT_B);

    const prepared = await fx.coordinator.prepareNormal({
      oldSession: first,
      target: { kind: 'replacement', candidate: candidate.ref },
      client: bindEditor(fx, first),
      fence: sealed.fence,
      drain: sealed.drain,
      host: { host: 'project', projectKey: PROJECT_A },
      routes: { revoke: async () => ({ outcome: 'complete', destroyedSockets: 0 }) },
    });

    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw new Error('unreachable');
    expect(sameRef(prepared.receipt.oldSession, first)).toBe(true);
    expect(prepared.receipt.target).toEqual({ kind: 'replacement', candidate: candidate.ref });
    expect(prepared.receipt.client.document).toEqual(EDITOR_DOC);
    expect(prepared.receipt.fence).toBe(sealed.fence); // identity-bound
    expect(prepared.receipt.preparation).toEqual({
      kind: 'normal',
      report: { kind: 'drained', settled: 0 },
    });
    expect(prepared.receipt.host).toEqual({ host: 'project', projectKey: PROJECT_A });
  });

  it('binds a deactivation target — the shutdown variant of the same currency', async () => {
    const fx = commitFixture();
    const first = await firstRef(fx);
    const sealed = await drainedFence();
    const prepared = await fx.coordinator.prepareNormal({
      ...deactivationBase(fx, first, sealed),
    });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw new Error('unreachable');
    expect(prepared.receipt.target).toEqual({ kind: 'deactivation' });
    expect(typeof prepared.receipt.stopOldRun).toBe('function');
  });

  it('refuses the sealed timed-out verdict — and late terminality never rewrites it', async () => {
    const fx = commitFixture();
    const first = await firstRef(fx);
    const sealed = await timedOutFence();
    const base = deactivationBase(fx, first, sealed);
    const refused = await fx.coordinator.prepareNormal(base);
    expect(refused).toEqual({ kind: 'refused', reason: 'drain-timed-out' });

    // the stuck work now settles — the fence crosses to terminal-after-timeout,
    // but the verdict was sealed: the normal receipt still refuses
    sealed.release.resolve();
    await sealed.drain.settled;
    expect(sealed.fence.state).toBe('terminal-after-timeout');
    const still = await fx.coordinator.prepareNormal(base);
    expect(still).toEqual({ kind: 'refused', reason: 'drain-timed-out' });
  });

  it("refuses the terminal failed report — §4 step 3's abort path owns it, never a receipt", async () => {
    const fx = commitFixture();
    const first = await firstRef(fx);
    const clock = manualClock();
    const fence = createEditFence({ clock: clock.clock });
    const started = fence.fence(() => [
      settledEdit('conflicting-write', writeRejection('changed-baseline')),
    ]);
    if (started.kind !== 'fenced') throw new Error('unreachable');
    await started.drain.outcome;
    expect(fence.state).toBe('failed');
    const refused = await fx.coordinator.prepareNormal(
      deactivationBase(fx, first, { fence, drain: started.drain }),
    );
    expect(refused).toEqual({ kind: 'refused', reason: 'drain-failed' });
  });

  it('refuses a resumed fence — resume-before-receipt would certify a lie', async () => {
    const fx = commitFixture();
    const first = await firstRef(fx);
    const sealed = await drainedFence();
    expect(sealed.drain.resume()).toEqual({ kind: 'resumed' });
    const refused = await fx.coordinator.prepareNormal(deactivationBase(fx, first, sealed));
    expect(refused).toEqual({ kind: 'refused', reason: 'fence-resumed' });
  });

  it('refuses when the bound client is not the live authoritative editor of the old pair', async () => {
    const fx = commitFixture();
    const first = await firstRef(fx);
    const sealed = await drainedFence();
    const base = deactivationBase(fx, first, sealed); // binds the one live editor
    const diagnostic = fx.clients.bind({
      role: 'diagnostic',
      document: { webContentsId: 9, navigationId: 1 },
      sessionRef: first,
    });
    if (diagnostic.kind !== 'bound') throw new Error('expected the diagnostic binding');
    // a capability the registry never minted
    const stranger = await fx.coordinator.prepareNormal({
      ...base,
      client: {
        document: EDITOR_DOC,
        capability: 'never-minted',
        httpCapability: base.client.httpCapability,
      },
    });
    expect(stranger).toEqual({ kind: 'refused', reason: 'client-not-authoritative' });
    // the diagnostic's capability: live, bound at the pair — but read-only
    const readOnly = await fx.coordinator.prepareNormal({
      ...base,
      client: {
        document: { webContentsId: 9, navigationId: 1 },
        capability: diagnostic.capability,
        httpCapability: base.client.httpCapability,
      },
    });
    expect(readOnly).toEqual({ kind: 'refused', reason: 'client-not-authoritative' });
    // the HTTP-side binding naming nothing live
    const crossHttp = await fx.coordinator.prepareNormal({
      ...base,
      client: {
        document: EDITOR_DOC,
        capability: base.client.capability,
        httpCapability: 'http-stranger',
      },
    });
    expect(crossHttp).toEqual({ kind: 'refused', reason: 'client-not-authoritative' });
  });

  it("refuses a deactivation target minted without the outgoing run's stop seam", async () => {
    const fx = commitFixture();
    const first = await firstRef(fx);
    const sealed = await drainedFence();
    const base = deactivationBase(fx, first, sealed);
    const { stopOldRun: _stop, ...withoutStop } = base;
    const refused = await fx.coordinator.prepareNormal(withoutStop);
    expect(refused).toEqual({ kind: 'refused', reason: 'deactivation-without-stop' });
  });

  it('holds at most one live receipt per transition — the second prepare over the same identity refuses', async () => {
    const fx = commitFixture();
    const first = await firstRef(fx);
    const sealed = await drainedFence();
    const base = deactivationBase(fx, first, sealed);
    const prepared = await fx.coordinator.prepareNormal(base);
    expect(prepared.kind).toBe('prepared');
    // the same identity again (old pair + deactivation target), a fresh
    // input object: the ledger's duplicate-live guard answers through
    // the prepare surface — no second receipt can exist to re-linearize
    // the transition the first already binds
    const duplicate = await fx.coordinator.prepareNormal({ ...base });
    expect(duplicate).toEqual({ kind: 'refused', reason: 'transition-already-prepared' });
    // a different target is a different transition — it still mints
    const other = await fx.coordinator.prepareNormal({
      ...base,
      target: {
        kind: 'replacement',
        candidate: { runtimeEpoch: first.runtimeEpoch, generation: 42 },
      },
    });
    expect(other.kind).toBe('prepared');
  });
});

describe('the forced preparation — the observed exact write-executor exit', () => {
  it('kills the exact executor, observes its exit, and mints the forced receipt binding it', async () => {
    const fx = commitFixture();
    const first = await firstRef(fx);
    const sealed = await timedOutFence();
    const reap = fakeExecutor();
    const pending = fx.coordinator.prepareForced({
      ...deactivationBase(fx, first, sealed),
      executor: reap.executor,
    });
    reap.settleExit(null, 'SIGKILL'); // the exit observation arrives
    const prepared = await pending;
    expect(reap.killCalls).toBe(1);
    expect(fx.reapClock.armedDelays()).toEqual([2000]); // the protocol's forced-reap bound
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw new Error('unreachable');
    expect(prepared.receipt.preparation).toEqual({
      kind: 'forced',
      exit: { code: null, signal: 'SIGKILL' },
    });
    expect(sameRef(prepared.receipt.oldSession, first)).toBe(true);
  });

  it('mints over an exit that had already settled — the observation, not the kill ordering, is the proof', async () => {
    const fx = commitFixture();
    const first = await firstRef(fx);
    const sealed = await timedOutFence();
    const reap = fakeExecutor();
    reap.settleExit(0, null); // the executor died on its own before the force
    const prepared = await fx.coordinator.prepareForced({
      ...deactivationBase(fx, first, sealed),
      executor: reap.executor,
    });
    expect(prepared.kind).toBe('prepared');
  });

  it('a rejecting exit observation is an un-observed exit — incomplete reap, no receipt', async () => {
    const fx = commitFixture();
    const first = await firstRef(fx);
    const sealed = await timedOutFence();
    const reap = fakeExecutor();
    reap.failExit(); // the observation seam itself fails: fail closed, never a guessed receipt
    const outcome = await fx.coordinator.prepareForced({
      ...deactivationBase(fx, first, sealed),
      executor: reap.executor,
    });
    expect(outcome).toEqual({ kind: 'incomplete-reap' });
    expect(reap.killCalls).toBe(1); // the force still fired; only the mint is refused
  });

  it('refuses the forced mint over an identity a live receipt already binds — the currency law crosses variants', async () => {
    const fx = commitFixture();
    const first = await firstRef(fx);
    const clock = manualClock();
    const fence = createEditFence({ clock: clock.clock });
    const started = fence.fence();
    if (started.kind !== 'fenced') throw new Error('unreachable');
    await started.drain.outcome; // a clean drain: the normal variant mints
    const base = deactivationBase(fx, first, { fence, drain: started.drain });
    expect((await fx.coordinator.prepareNormal(base)).kind).toBe('prepared');
    // the same identity forced (the fence is not part of the identity):
    // the kill fires — the exact executor this identity's transition
    // would retire — the exit is observed, and the mint refuses,
    // because the identity already holds a live receipt
    const stuck = await timedOutFence();
    const reap = fakeExecutor();
    reap.settleExit(null, 'SIGKILL');
    const refused = await fx.coordinator.prepareForced({
      ...base,
      fence: stuck.fence,
      drain: stuck.drain,
      executor: reap.executor,
    });
    expect(refused).toEqual({ kind: 'refused', reason: 'transition-already-prepared' });
  });

  it('an incomplete forced reap creates NO receipt — the candidate rolls back and old authority stays unrevoked', async () => {
    const fx = commitFixture();
    const firstSeat = await activateFirst(fx, PROJECT_A);
    const sealed = await timedOutFence();
    firstSeat.drain = sealed.drain;
    const candidate = await beginCandidate(fx, PROJECT_B);
    const reap = fakeExecutor(); // the exit never settles
    const pending = fx.coordinator.prepareForced({
      oldSession: firstSeat.ref,
      target: { kind: 'replacement', candidate: candidate.ref },
      client: firstSeat.client,
      fence: sealed.fence,
      drain: sealed.drain,
      host: { host: 'project', projectKey: PROJECT_A },
      routes: firstSeat.lease,
      executor: reap.executor,
    });
    fx.reapClock.fireDeadline(); // the 2-second forced-reap deadline: unobserved
    const outcome = await pending;
    expect(outcome).toEqual({ kind: 'incomplete-reap' });
    // the composition's answer: roll the candidate back under F4's
    // reason — and NOTHING was revoked (no receipt ever existed)
    const candidateRun = fx.runs[1];
    if (candidateRun === undefined) throw new Error('expected the candidate run');
    const rollback = candidate.rollback('incomplete-reap');
    candidateRun.closeWith(completeReport('stopped'));
    await rollback;
    expect(
      fx.capabilityGrants.verify(firstSeat.cookie, { host: 'project', projectKey: PROJECT_A }),
    ).toBe(true);
    expect(firstSeat.lease.revocations).toBe(0);
    expect(fx.grantEvictions).toEqual([]);
    expect(fx.supervisor.snapshot().active?.ref).toEqual(firstSeat.ref); // old authority unrevoked
    expect(
      fx.clients.authorize({
        capability: firstSeat.client.capability,
        document: EDITOR_DOC,
        sessionRef: firstSeat.ref,
      }),
    ).toEqual({ kind: 'authorized', role: 'editor' });
  });

  it('refuses the force path on a fence that is not in the timed-out states', async () => {
    const fx = commitFixture();
    const first = await firstRef(fx);
    const sealed = await drainedFence(); // drained — the normal path owns this fence
    const reap = fakeExecutor();
    const refused = await fx.coordinator.prepareForced({
      ...deactivationBase(fx, first, sealed),
      executor: reap.executor,
    });
    expect(refused).toEqual({ kind: 'refused', reason: 'fence-not-timed-out' });
    expect(reap.killCalls).toBe(0); // never terminated what it may not
  });
});

/** The shared deactivation mint input over the given sealed fence — the legs override one variable each. */
function deactivationBase(
  fx: ReturnType<typeof commitFixture>,
  oldSession: SessionSeat['ref'],
  sealed: { readonly fence: EditFence; readonly drain: EditDrain },
): SwitchPreparationInput & { readonly stopOldRun: () => void } {
  return {
    oldSession,
    target: { kind: 'deactivation' },
    client: bindEditor(fx, oldSession),
    fence: sealed.fence,
    drain: sealed.drain,
    host: { host: 'project', projectKey: PROJECT_A },
    routes: { revoke: async () => ({ outcome: 'complete', destroyedSockets: 0 }) },
    stopOldRun: () => {},
  };
}

describe('the authoritative-client law shared by both variants', () => {
  it('the forced mint refuses a non-authoritative client before it ever touches the executor', async () => {
    const fx = commitFixture();
    const first = await firstRef(fx);
    const sealed = await timedOutFence();
    const reap = fakeExecutor();
    const refused = await fx.coordinator.prepareForced({
      ...deactivationBase(fx, first, sealed),
      client: { document: EDITOR_DOC, capability: 'never-minted', httpCapability: 'never-minted' },
      executor: reap.executor,
    });
    expect(refused).toEqual({ kind: 'refused', reason: 'client-not-authoritative' });
    expect(reap.killCalls).toBe(0);
  });
});
