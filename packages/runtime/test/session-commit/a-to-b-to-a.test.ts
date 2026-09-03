import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ProjectKey,
  RequestEnvelope,
  ResponseEnvelope,
  SessionRef,
} from '@wojciechpiskorz/astroix-protocol';
import { MUTATION_HEADER_NAME, MUTATION_HEADER_VALUE } from '@wojciechpiskorz/astroix-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatchApiRequest } from '../../api/http/api-dispatch.ts';
import { type ClientBindings, createClientBindings } from '../../api/http/client-bindings.ts';
import {
  CAPABILITY_COOKIE_NAME,
  createHostCapabilityGrants,
  type HostCapabilityGrants,
} from '../../api/http/host-capability.ts';
import { createGrantTable, type GrantTable } from '../../edit-authority/grants/grant-table.ts';
import {
  createOriginListener,
  type OriginLease,
  type OriginListener,
} from '../../origin/origin-listener.ts';
import {
  captureMenuAction,
  createSessionClients,
  executeMenuAction,
} from '../../session-supervisor/clients/session-clients.ts';
import type { SwitchCoordinator } from '../../session-supervisor/commit/switch-coordinator.ts';
import { createSwitchCoordinator } from '../../session-supervisor/commit/switch-coordinator.ts';
import type { AuthoritativeClient } from '../../session-supervisor/commit/switch-receipt.ts';
import type { EditDrain, EditFence } from '../../session-supervisor/fence/edit-fence.ts';
import { createEditFence } from '../../session-supervisor/fence/edit-fence.ts';
import {
  createSessionSupervisor,
  type SessionSupervisor,
  type StagedCandidate,
} from '../../session-supervisor/staging/session-supervisor.ts';
import { admitSseStream } from '../../sse/sse-admission.ts';
import { ssePublication } from '../../sse/sse-frames.ts';
import { createSseHub, type SseHub } from '../../sse/sse-hub.ts';
import {
  cleanupScratch,
  EDITOR_DOC,
  EPOCH,
  type FakeRun,
  fakeRun,
  makeProjectRoot,
  manualClock,
  PROJECT_A,
  PROJECT_B,
  rawGet,
  rawStatus,
  sameRef,
} from './commit-harness.ts';

/**
 * The #238 focused tests, part 4 — the two-target A-to-B-to-A cycle
 * over the REAL landed surfaces (ADR-0006 §5): activate A, switch to
 * B, switch back to A — every commit through this lane's receipt-gated
 * coordinator — then prove the FIRST A's tab is dead on every axis:
 * its host 421s while retired (the real origin listener, real loopback
 * socket), its SSE stream ended at the switch and its stale
 * publications are refused, its resource grants (and any undo or
 * mutation replaying them) read unknown, its query/selection/mutation
 * commands are refused by the REAL dispatch (revoked cookie, dead
 * binding, stale pair — in that admission order), its menu actions are
 * stale, and it cannot regain authority after the cycle even holding
 * the rotated cookie.
 */

/** A digest oracle independent of the module under test (the grants-harness idiom). */
function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** One session's seat over the REAL surfaces. */
interface Seat {
  readonly ref: SessionRef;
  readonly projectKey: ProjectKey;
  readonly fence: EditFence;
  drain: EditDrain | null;
  readonly lease: OriginLease;
  readonly client: AuthoritativeClient;
  readonly cookie: string;
}

interface Battery {
  readonly root: string;
  readonly supervisor: SessionSupervisor;
  readonly coordinator: SwitchCoordinator;
  readonly clients: ReturnType<typeof createSessionClients>;
  readonly httpBindings: ClientBindings;
  readonly capabilityGrants: HostCapabilityGrants;
  readonly hub: SseHub;
  readonly grantTable: GrantTable;
  readonly listener: OriginListener;
  readonly port: number;
  readonly runs: FakeRun[];
  active: Seat | null;
}

let battery: Battery | null = null;

beforeEach(async () => {
  const root = await makeProjectRoot();
  const grantTable = await createGrantTable(root);
  const listener = await createOriginListener();
  const clients = createSessionClients();
  const httpBindings = createClientBindings();
  const capabilityGrants = createHostCapabilityGrants();
  const hub = createSseHub();
  const runs: FakeRun[] = [];
  const supervisor = createSessionSupervisor({
    startCandidate: () => {
      const fake = fakeRun();
      runs.push(fake);
      return fake.run;
    },
    runtimeEpoch: EPOCH,
    hostCapabilities: capabilityGrants,
    clients,
  });
  const coordinator = createSwitchCoordinator({
    clients,
    hostCapabilities: capabilityGrants,
    streams: hub,
    grants: grantTable,
    httpBindings,
  });
  battery = {
    root,
    supervisor,
    coordinator,
    clients,
    httpBindings,
    capabilityGrants,
    hub,
    grantTable,
    listener,
    port: listener.port,
    runs,
    active: null,
  };
});

afterEach(async () => {
  const current = battery;
  battery = null;
  await current?.listener.close();
  await cleanupScratch();
});

/** Grants the session's REAL origin lease (a dead loopback upstream — nothing is proxied in these legs). */
function grantLease(b: Battery, projectKey: ProjectKey): OriginLease {
  return b.listener.grantProjectLease({
    projectKey,
    upstream: { host: '127.0.0.1', port: 9 },
  });
}

/** Binds the session's authoritative editor on both tables and seats it. */
function seat(b: Battery, ref: SessionRef, projectKey: ProjectKey, lease: OriginLease): Seat {
  const bound = b.clients.bind({ role: 'editor', document: EDITOR_DOC, sessionRef: ref });
  const http = b.httpBindings.bind({ role: 'editor', host: 'project', sessionRef: ref });
  if (bound.kind !== 'bound' || http.kind !== 'bound')
    throw new Error('expected the editor bindings');
  const seat: Seat = {
    ref,
    projectKey,
    fence: createEditFence({ clock: manualClock().clock }),
    drain: null,
    lease,
    client: { document: EDITOR_DOC, capability: bound.capability, httpCapability: http.capability },
    cookie: b.capabilityGrants.current({ host: 'project', projectKey }) ?? '',
  };
  b.active = seat;
  return seat;
}

/** Begins one candidate and hands back its staged handle. */
async function begin(b: Battery, projectKey: ProjectKey): Promise<StagedCandidate> {
  const begun = b.supervisor.begin(projectKey);
  if (begun.kind !== 'begun') throw new Error(`expected admission, refused: ${begun.reason}`);
  const run = b.runs[b.runs.length - 1];
  if (run === undefined) throw new Error('no candidate run was started');
  run.settleReady();
  return await begun.attempt.ready;
}

/** The first activation: F4's plain commit (no old session), then the real lease and editor. */
async function activateFirst(b: Battery, projectKey: ProjectKey): Promise<Seat> {
  const candidate = await begin(b, projectKey);
  const result = await candidate.commit();
  return seat(b, result.committed, projectKey, grantLease(b, projectKey));
}

/** The receipt-gated switch: drain the old session clean, consume the receipt, grant the successor. */
async function switchSession(b: Battery, projectKey: ProjectKey): Promise<Seat> {
  const old = b.active;
  if (old === null) throw new Error('no active session to switch from');
  const candidate = await begin(b, projectKey);
  const started = old.fence.fence();
  if (started.kind !== 'fenced') throw new Error('expected the drain to start');
  old.drain = started.drain;
  await started.drain.outcome;
  const prepared = await b.coordinator.prepareNormal({
    oldSession: old.ref,
    target: { kind: 'replacement', candidate: candidate.ref },
    client: old.client,
    fence: old.fence,
    drain: started.drain,
    host: { host: 'project', projectKey: old.projectKey },
    routes: old.lease,
  });
  if (prepared.kind !== 'prepared')
    throw new Error(`expected a receipt, refused: ${prepared.reason}`);
  const committed = await b.coordinator.commit(prepared.receipt, candidate);
  if (committed.kind !== 'committed') throw new Error(`expected a commit, got: ${committed.kind}`);
  return seat(b, committed.committed, projectKey, grantLease(b, projectKey));
}

/** The cycle's tail as one move: switch to B, then back to A — every old-tab leg starts from its A2 seat. */
async function switchBThenBack(b: Battery): Promise<Seat> {
  await switchSession(b, PROJECT_B);
  return await switchSession(b, PROJECT_A);
}

/** The dispatch authority bound to the REAL supervisor snapshot and capability tables. */
function dispatchAuthority(b: Battery, executed: unknown[]) {
  return {
    expectedPort: b.port,
    sessionState: () => {
      const snap = b.supervisor.snapshot();
      return { sessionRef: snap.active?.ref ?? null, projectKey: snap.active?.projectKey ?? null };
    },
    verifyHostCapability: b.capabilityGrants.verify,
    resolveClientBinding: b.httpBindings.resolve,
    executeCommand: async (envelope: RequestEnvelope) => {
      executed.push(envelope);
      const result: ResponseEnvelope = {
        protocolVersion: 1,
        requestId: 'unused',
        result: { kind: 'project-list', projects: [] },
      };
      return result;
    },
  };
}

/** One command request's evidence against the given session's tab state. */
function commandEvidence(
  b: Battery,
  projectKey: ProjectKey,
  input: {
    readonly session: SessionRef;
    readonly cookie: string;
    readonly clientCapability: string;
    readonly body: string;
    readonly mutation: boolean;
  },
) {
  const headers: Array<[string, string]> = [
    ['Host', `${projectKey}.localhost:${b.port}`],
    ['Content-Type', 'application/json'],
    ['Cookie', `${CAPABILITY_COOKIE_NAME}=${input.cookie}`],
    ['X-Astroix-Client', input.clientCapability],
  ];
  if (input.mutation) {
    headers.push([MUTATION_HEADER_NAME, MUTATION_HEADER_VALUE]);
    headers.push(['Origin', `http://${projectKey}.localhost:${b.port}`]);
  } else {
    headers.push(['Sec-Fetch-Site', 'same-origin']);
  }
  return {
    method: 'POST',
    url: '/__astroix/api/v1',
    rawHeaders: headers.flat(),
    body: input.body,
  };
}

/** The sanitized error code off one refusal draft (never a status-only guess). */
function errorCode(draft: { readonly body: string }): string {
  return (JSON.parse(draft.body) as { error: { code: string } }).error.code;
}

function inspectBody(session: SessionRef): string {
  return JSON.stringify({
    protocolVersion: 1,
    requestId: 'req-1',
    session,
    command: { kind: 'inspect', request: { kind: 'styles' } },
  });
}

function applyEditBody(session: SessionRef, token: string): string {
  return JSON.stringify({
    protocolVersion: 1,
    requestId: 'req-1',
    session,
    command: {
      kind: 'apply-edit',
      plan: {
        operation: 'replace-contents',
        grant: {
          token,
          kind: 'css',
          operations: ['replace-contents'],
          displayPath: 'src/styles/global.css',
          baseline: { type: 'sha256', sha256: 'a'.repeat(64) },
        },
        contents: 'body { color: red; }',
      },
    },
  });
}

describe('the A-to-B-to-A cycle — every axis of the first A’s tab is dead', () => {
  it('commits three sessions with three fresh generations through the receipt-gated coordinator', async () => {
    const b = battery as Battery;
    const a1 = await activateFirst(b, PROJECT_A);
    const br = await switchSession(b, PROJECT_B);
    const a2 = await switchSession(b, PROJECT_A);
    expect([a1.ref.generation, br.ref.generation, a2.ref.generation]).toEqual([1, 2, 3]);
    expect(a1.ref.runtimeEpoch).toBe(a2.ref.runtimeEpoch); // one control-plane lifetime
    expect(sameRef(b.supervisor.snapshot().active?.ref ?? a1.ref, a2.ref)).toBe(true);
  });

  it('the retired host answers 421 — the old route is dead, reserved paths included', async () => {
    const b = battery as Battery;
    await activateFirst(b, PROJECT_A);
    await switchSession(b, PROJECT_B);
    // A's host retired at the B commit: 421 for everything, never proxied
    expect(await rawStatus(b.port, rawGet('/', `${PROJECT_A}.localhost`))).toBe(421);
    expect(await rawStatus(b.port, rawGet('/__astroix/events', `${PROJECT_A}.localhost`))).toBe(
      421,
    );
    // the A return retires B the same way
    await switchSession(b, PROJECT_A);
    expect(await rawStatus(b.port, rawGet('/', `${PROJECT_B}.localhost`))).toBe(421);
  });

  it('the old session’s SSE stream ended at the commit and its publications are stale forever', async () => {
    const b = battery as Battery;
    const a1 = await activateFirst(b, PROJECT_A);
    let closes = 0;
    const admitted = b.hub.admit({
      role: 'editor',
      host: { host: 'project', projectKey: PROJECT_A },
      session: a1.ref,
      clientCapability: a1.client.httpCapability,
      sink: () => {},
      close: () => {
        closes += 1;
      },
    });
    expect(admitted.kind).toBe('admitted');

    await switchSession(b, PROJECT_B);
    expect(closes).toBe(1); // the stream died with the commit, not the tab

    // a publication minted under the retired pair is refused whole
    const stale = ssePublication({
      session: a1.ref,
      event: { type: 'diagnostic', level: 'info', message: 'stale probe' },
    });
    if (stale === null) throw new Error('expected a publication');
    expect(b.hub.publish(stale)).toMatchObject({ kind: 'refused', reason: 'stale-publication' });

    await switchSession(b, PROJECT_A);
    // still refused after the A return — the pair died with its session
    expect(b.hub.publish(stale).kind).toBe('refused');
  });

  it('the old tab’s events admission is refused — dead cookie, and a rotated cookie cannot resurrect it', async () => {
    const b = battery as Battery;
    const a1 = await activateFirst(b, PROJECT_A);
    const a2Seat = await switchBThenBack(b);
    const authority = {
      expectedPort: b.port,
      sessionState: () => {
        const snap = b.supervisor.snapshot();
        return {
          sessionRef: snap.active?.ref ?? null,
          projectKey: snap.active?.projectKey ?? null,
        };
      },
      verifyHostCapability: b.capabilityGrants.verify,
      resolveClientBinding: b.httpBindings.resolve,
    };
    const eventsUrl = `/__astroix/events?runtimeEpoch=${encodeURIComponent(EPOCH)}&generation=${a1.ref.generation}`;
    // the old cookie: revoked at the B commit
    const oldCookie = admitSseStream(
      {
        method: 'GET',
        url: eventsUrl,
        rawHeaders: [
          'Host',
          `${PROJECT_A}.localhost:${b.port}`,
          'Origin',
          `http://${PROJECT_A}.localhost:${b.port}`,
          'Cookie',
          `${CAPABILITY_COOKIE_NAME}=${a1.cookie}`,
          'X-Astroix-Client',
          a1.client.httpCapability,
        ],
      },
      authority,
    );
    expect(oldCookie.kind).toBe('refused');
    // the regain attempt: the rotated A2 cookie with the dead binding
    const regain = admitSseStream(
      {
        method: 'GET',
        url: eventsUrl,
        rawHeaders: [
          'Host',
          `${PROJECT_A}.localhost:${b.port}`,
          'Origin',
          `http://${PROJECT_A}.localhost:${b.port}`,
          'Cookie',
          `${CAPABILITY_COOKIE_NAME}=${a2Seat.cookie}`,
          'X-Astroix-Client',
          a1.client.httpCapability,
        ],
      },
      authority,
    );
    expect(regain.kind).toBe('refused');
  });

  it('the old session’s resource grants are evicted — a mutation or undo replaying one reads unknown', async () => {
    const b = battery as Battery;
    const a1 = await activateFirst(b, PROJECT_A);
    // a real discovered resource over the real table (the grants idiom)
    await mkdir(join(b.root, 'src/styles'), { recursive: true });
    await writeFile(join(b.root, 'src/styles/global.css'), 'body { color: red; }\n');
    const issued = await b.grantTable.issue(
      {
        discovery: 'existing-text',
        kind: 'css',
        path: 'src/styles/global.css',
        revision: digestOf('body { color: red; }\n'),
      },
      a1.ref,
    );
    if (!issued.ok) throw new Error(`expected a grant, failed: ${issued.code}`);
    // live before the switch (non-vacuous pin)
    expect(
      b.grantTable.authorize({
        token: issued.grant.token,
        session: a1.ref,
        kind: 'css',
        operation: 'replace-contents',
      }).ok,
    ).toBe(true);

    await switchSession(b, PROJECT_B);
    await switchSession(b, PROJECT_A);
    const evicted = b.grantTable.authorize({
      token: issued.grant.token,
      session: a1.ref,
      kind: 'css',
      operation: 'replace-contents',
    });
    expect(evicted).toEqual({ ok: false, code: 'unknown-grant', message: expect.any(String) });
    // the undo axis: the same dead token under the splice operation reads the same refusal
    const undo = b.grantTable.authorize({
      token: issued.grant.token,
      session: a1.ref,
      kind: 'css',
      operation: 'splice',
    });
    expect(undo.ok).toBe(false);
    if (!undo.ok) expect(undo.code).toBe('unknown-grant');
  });

  it('a stale query is refused by the real dispatch — revoked cookie first, stale pair even with fresh authority', async () => {
    const b = battery as Battery;
    const a1 = await activateFirst(b, PROJECT_A);
    const a2Seat = await switchBThenBack(b);
    const executed: unknown[] = [];
    const authority = dispatchAuthority(b, executed);

    // the old tab's re-fetch: its cookie died at the B commit
    const oldCookie = await dispatchApiRequest(
      commandEvidence(b, PROJECT_A, {
        session: a1.ref,
        cookie: a1.cookie,
        clientCapability: a1.client.httpCapability,
        body: inspectBody(a1.ref),
        mutation: false,
      }),
      authority,
    );
    expect(oldCookie.status).toBe(403);
    expect(errorCode(oldCookie)).toBe('unauthorized');

    // the regain attempt: the rotated A2 cookie and the live A2 editor's
    // binding, still claiming the retired pair
    const regain = await dispatchApiRequest(
      commandEvidence(b, PROJECT_A, {
        session: a1.ref,
        cookie: a2Seat.cookie,
        clientCapability: a2Seat.client.httpCapability,
        body: inspectBody(a1.ref),
        mutation: false,
      }),
      authority,
    );
    expect(regain.status).toBe(409);
    expect(errorCode(regain)).toBe('stale-session');
    expect(executed).toEqual([]); // nothing ever reached the executor
  });

  it('a stale selection restore is refused — the old tab’s document binding never covers the traffic', async () => {
    const b = battery as Battery;
    const a1 = await activateFirst(b, PROJECT_A);
    const a2Seat = await switchBThenBack(b);
    const executed: unknown[] = [];
    // the selection-restore rehydrate rides a session-scoped read from
    // the old tab's document: its binding was unbound at the commit —
    // even the rotated cookie cannot speak for it
    const refused = await dispatchApiRequest(
      commandEvidence(b, PROJECT_A, {
        session: a1.ref,
        cookie: a2Seat.cookie,
        clientCapability: a1.client.httpCapability,
        body: inspectBody(a1.ref),
        mutation: false,
      }),
      dispatchAuthority(b, executed),
    );
    expect(refused.status).toBe(403);
    expect(errorCode(refused)).toBe('unauthorized');
    expect(executed).toEqual([]);
  });

  it('a stale mutation is refused at every admission stage it could present', async () => {
    const b = battery as Battery;
    const a1 = await activateFirst(b, PROJECT_A);
    const a2Seat = await switchBThenBack(b);
    const executed: unknown[] = [];
    const authority = dispatchAuthority(b, executed);

    // the old cookie: dead at transport admission
    const oldCookie = await dispatchApiRequest(
      commandEvidence(b, PROJECT_A, {
        session: a1.ref,
        cookie: a1.cookie,
        clientCapability: a1.client.httpCapability,
        body: applyEditBody(a1.ref, 'opaque-grant-token'),
        mutation: true,
      }),
      authority,
    );
    expect(oldCookie.status).toBe(403);
    expect(errorCode(oldCookie)).toBe('unauthorized');

    // the regain attempt with the new authority, still claiming the retired pair
    const regain = await dispatchApiRequest(
      commandEvidence(b, PROJECT_A, {
        session: a1.ref,
        cookie: a2Seat.cookie,
        clientCapability: a2Seat.client.httpCapability,
        body: applyEditBody(a1.ref, 'opaque-grant-token'),
        mutation: true,
      }),
      authority,
    );
    expect(regain.status).toBe(409);
    expect(errorCode(regain)).toBe('stale-session');
    expect(executed).toEqual([]);
  });

  it('a menu action captured at the first A is stale after every switch of the cycle', async () => {
    const b = battery as Battery;
    const a1 = await activateFirst(b, PROJECT_A);
    const envelope = captureMenuAction({ sessionRef: a1.ref, action: 'workbench.reset-selection' });
    const current = (): SessionRef | null => b.supervisor.snapshot().active?.ref ?? null;

    await switchSession(b, PROJECT_B);
    expect(executeMenuAction(envelope, current())).toEqual({
      kind: 'rejected',
      reason: 'stale-session',
    });
    await switchSession(b, PROJECT_A);
    expect(executeMenuAction(envelope, current())).toEqual({
      kind: 'rejected',
      reason: 'stale-session',
    });
    // the current session's own action still executes
    const fresh = captureMenuAction({
      sessionRef: current() as SessionRef,
      action: 'workbench.reset-selection',
    });
    expect(executeMenuAction(fresh, current()).kind).toBe('accepted');
  });

  it('the old tab cannot regain authority — every truth of its identity is dead after the cycle', async () => {
    const b = battery as Battery;
    const a1 = await activateFirst(b, PROJECT_A);
    const a2Seat = await switchBThenBack(b);

    // its host capability never verifies again
    expect(b.capabilityGrants.verify(a1.cookie, { host: 'project', projectKey: PROJECT_A })).toBe(
      false,
    );
    // its supervisor-side binding is gone, its pair never upgrades
    expect(
      b.clients.authorize({
        capability: a1.client.capability,
        document: EDITOR_DOC,
        sessionRef: a1.ref,
      }),
    ).toEqual({ kind: 'rejected', reason: 'no-binding' });
    expect(
      b.clients.authorize({
        capability: a1.client.capability,
        document: EDITOR_DOC,
        sessionRef: a2Seat.ref,
      }).kind,
    ).toBe('rejected');
    // its HTTP-side binding resolves to nothing
    expect(b.httpBindings.resolve(a1.client.httpCapability)).toBeNull();
    // while the successor's own authority works — the A2 editor's binding
    // reads and would edit at the new pair
    expect(
      b.clients.authorize({
        capability: a2Seat.client.capability,
        document: EDITOR_DOC,
        sessionRef: a2Seat.ref,
        role: 'editor',
      }),
    ).toEqual({ kind: 'authorized', role: 'editor' });
  });
});
