import type { ProjectKey, SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import { createHostCapabilityGrants } from '../../api/http/host-capability.ts';
import {
  type ClientDocument,
  captureMenuAction,
  createSessionClients,
  executeMenuAction,
} from '../../session-supervisor/clients/session-clients.ts';
import {
  createSessionSupervisor,
  type SessionSupervisor,
} from '../../session-supervisor/staging/session-supervisor.ts';
import {
  type CandidateRuntimeControl,
  candidateRuntime,
  completeReport,
  flush,
  PROJECT_A,
  PROJECT_B,
} from './staging-harness.ts';

/**
 * The #236 focused tests, part 4 — the two-target A-to-B-to-A cycle
 * (ADR-0006 §5 "An old tab stays invalid after an A-to-B-to-A cycle
 * (new generation, host capability, client binding)"; the charter's
 * evidence line, this lane's slice): activate A, switch to B, switch
 * back to A — then prove the FIRST A's tab is dead on every axis this
 * lane owns: stale SessionRef, revoked host cookie, revoked client
 * binding, rejected menu action — while a diagnostic bound to the new
 * session stays read-only. The host capability table is F2's landed
 * module (read-only composition); the supervisor drives its rotation.
 */

/** The authoritative editor's document — one webContents, its first navigation. */
const DOC: ClientDocument = { webContentsId: 7, navigationId: 1 };

interface Cycle {
  readonly supervisor: SessionSupervisor;
  readonly control: CandidateRuntimeControl;
  readonly grants: ReturnType<typeof createHostCapabilityGrants>;
  readonly clients: ReturnType<typeof createSessionClients>;
}

function cycle(): Cycle {
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

/** Activates one project to a committed, ready session and returns its reference. */
async function activate(c: Cycle, projectKey: ProjectKey): Promise<SessionRef> {
  const begun = c.supervisor.begin(projectKey);
  if (begun.kind !== 'begun') throw new Error(`expected admission, refused: ${begun.reason}`);
  const run = c.control.runs[c.control.runs.length - 1];
  if (run === undefined) throw new Error('no candidate run was started');
  run.settleReady();
  const candidate = await begun.attempt.ready;
  const result = await candidate.commit();
  return result.committed;
}

/** The active session's reference off the snapshot — the currency every rejection checks against. */
function currentRef(c: Cycle): SessionRef | null {
  return c.supervisor.snapshot().active?.ref ?? null;
}

describe('the A-to-B-to-A cycle — every axis of the first A\u2019s tab is dead', () => {
  it('the cycle itself commits three sessions with three fresh generations', async () => {
    const c = cycle();
    const refA1 = await activate(c, PROJECT_A);
    const refB = await activate(c, PROJECT_B);
    const refA2 = await activate(c, PROJECT_A);
    expect(refA1.generation).toBe(1);
    expect(refB.generation).toBe(2);
    expect(refA2.generation).toBe(3);
    expect(refA1.runtimeEpoch).toBe(refA2.runtimeEpoch); // one control-plane lifetime
    expect(c.supervisor.snapshot().active).toEqual({
      ref: refA2,
      projectKey: PROJECT_A,
      state: 'ready',
    });
  });

  it('the first A\u2019s stale SessionRef is rejected on every axis', async () => {
    const c = cycle();
    const refA1 = await activate(c, PROJECT_A);
    // the tab binds as the authoritative editor of the first A session
    const bound = c.clients.bind({ role: 'editor', document: DOC, sessionRef: refA1 });
    if (bound.kind !== 'bound') throw new Error('expected the editor binding');

    await activate(c, PROJECT_B);
    await activate(c, PROJECT_A);

    // a session-scoped command carrying the retired pair: the binding is gone…
    expect(
      c.clients.authorize({ capability: bound.capability, document: DOC, sessionRef: refA1 }),
    ).toEqual({ kind: 'rejected', reason: 'no-binding' });
    // …and even a live binding minted at the NEW pair rejects the stale pair
    const fresh = c.clients.bind({
      role: 'editor',
      document: { webContentsId: 30, navigationId: 1 },
      sessionRef: currentRef(c) as SessionRef,
    });
    if (fresh.kind !== 'bound') throw new Error('unreachable');
    expect(
      c.clients.authorize({
        capability: fresh.capability,
        document: { webContentsId: 30, navigationId: 1 },
        sessionRef: refA1,
      }),
    ).toEqual({ kind: 'rejected', reason: 'stale-session' });
  });

  it('the first A\u2019s host cookie is dead — revoked at the B commit, not resurrected by the A return', async () => {
    const c = cycle();
    await activate(c, PROJECT_A);
    // the cookie the first A tab holds: the capability minted at its commit
    const cookieA1 = c.grants.current({ host: 'project', projectKey: PROJECT_A });
    if (cookieA1 === null)
      throw new Error('expected the committed activation to mint a capability');
    expect(c.grants.verify(cookieA1, { host: 'project', projectKey: PROJECT_A })).toBe(true);

    // mid-B-candidate the old cookie still works — authority moves only at commit
    const begun = c.supervisor.begin(PROJECT_B);
    if (begun.kind !== 'begun') throw new Error('unreachable');
    const midCandidate = c.control.runs[c.control.runs.length - 1];
    if (midCandidate === undefined) throw new Error('unreachable');
    expect(c.grants.verify(cookieA1, { host: 'project', projectKey: PROJECT_A })).toBe(true);
    midCandidate.settleReady();
    await (await begun.attempt.ready).commit();

    // after the B commit the old host authority is revoked
    expect(c.grants.verify(cookieA1, { host: 'project', projectKey: PROJECT_A })).toBe(false);

    // the A return mints a FRESH capability — the old cookie never verifies again
    await activate(c, PROJECT_A);
    const cookieA2 = c.grants.current({ host: 'project', projectKey: PROJECT_A });
    if (cookieA2 === null) throw new Error('expected the return commit to mint a capability');
    expect(cookieA2).not.toBe(cookieA1);
    expect(c.grants.verify(cookieA1, { host: 'project', projectKey: PROJECT_A })).toBe(false);
    expect(c.grants.verify(cookieA2, { host: 'project', projectKey: PROJECT_A })).toBe(true);
  });

  it('the first A\u2019s client binding is revoked at the switch — navigation to the old host never upgrades it', async () => {
    const c = cycle();
    const refA1 = await activate(c, PROJECT_A);
    const editor = c.clients.bind({ role: 'editor', document: DOC, sessionRef: refA1 });
    if (editor.kind !== 'bound') throw new Error('unreachable');
    const diagnostic = c.clients.bind({
      role: 'diagnostic',
      document: { webContentsId: 8, navigationId: 1 },
      sessionRef: refA1,
    });
    if (diagnostic.kind !== 'bound') throw new Error('unreachable');

    await activate(c, PROJECT_B);

    // session replacement revoked both of the first A's bindings
    expect(c.clients.counts()).toEqual({ editor: 0, diagnostic: 0 });
    expect(
      c.clients.authorize({ capability: editor.capability, document: DOC, sessionRef: refA1 }).kind,
    ).toBe('rejected');
    // receiving the rotated host cookie cannot resurrect them: the
    // capability names a dead binding regardless of what cookie rides along
    expect(
      c.clients.authorize({
        capability: editor.capability,
        document: DOC,
        sessionRef: { runtimeEpoch: refA1.runtimeEpoch, generation: 2 },
      }).kind,
    ).toBe('rejected');
  });

  it('a menu action captured at the first A is rejected at execution after the cycle', async () => {
    const c = cycle();
    const refA1 = await activate(c, PROJECT_A);
    const envelope = captureMenuAction({ sessionRef: refA1, action: 'workbench.reset-selection' });

    await activate(c, PROJECT_B);
    expect(executeMenuAction(envelope, currentRef(c))).toEqual({
      kind: 'rejected',
      reason: 'stale-session',
    });

    await activate(c, PROJECT_A);
    expect(executeMenuAction(envelope, currentRef(c))).toEqual({
      kind: 'rejected',
      reason: 'stale-session',
    });
    // the current session's own menu action still executes
    const fresh = captureMenuAction({
      sessionRef: currentRef(c) as SessionRef,
      action: 'workbench.reset-selection',
    });
    expect(executeMenuAction(fresh, currentRef(c)).kind).toBe('accepted');
  });

  it('the old session\u2019s run is stopped at the switch and never restarts itself', async () => {
    const c = cycle();
    await activate(c, PROJECT_A);
    const runA1 = c.control.runs[0];
    if (runA1 === undefined) throw new Error('unreachable');
    expect(runA1.stopCalls).toBe(0);
    await activate(c, PROJECT_B);
    expect(runA1.stopCalls).toBe(1);
    // its late teardown close is history: no failure is invented, no restart happens
    runA1.closeWith(completeReport('worker-crash'));
    await flush();
    expect(c.supervisor.snapshot().active?.projectKey).toBe(PROJECT_B);
    expect(c.supervisor.snapshot().lastFailure).toBeUndefined();
    expect(c.control.requests).toHaveLength(2);
  });

  it('a diagnostic bound to the new session stays read-only through the whole cycle', async () => {
    const c = cycle();
    await activate(c, PROJECT_A);
    const refB = await activate(c, PROJECT_B);

    const diagnostic = c.clients.bind({
      role: 'diagnostic',
      document: { webContentsId: 8, navigationId: 1 },
      sessionRef: refB,
    });
    if (diagnostic.kind !== 'bound') throw new Error('unreachable');

    // it reads (role-agnostic authorization names its diagnostic role)…
    expect(
      c.clients.authorize({
        capability: diagnostic.capability,
        document: { webContentsId: 8, navigationId: 1 },
        sessionRef: refB,
      }),
    ).toEqual({ kind: 'authorized', role: 'diagnostic' });
    // …and never edits, even mid-cycle of a further activation
    expect(
      c.clients.authorize({
        capability: diagnostic.capability,
        document: { webContentsId: 8, navigationId: 1 },
        sessionRef: refB,
        role: 'editor',
      }),
    ).toEqual({ kind: 'rejected', reason: 'wrong-role' });
  });
});
