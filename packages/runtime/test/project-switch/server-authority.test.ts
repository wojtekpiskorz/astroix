import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { RequestEnvelope, ResourceGrant, WritePlan } from '@wojciechpiskorz/astroix-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACTIVATION_BUDGET_MS,
  createSwitchHarness,
  type LiveProbe,
  launcherDocument,
  planePids,
  pollUntil,
  rawExchange,
  SETTLE_BUDGET_MS,
  type SwitchDocument,
  type SwitchHarness,
  type SwitchProject,
} from './harness.ts';

// @vitest-environment node — real managed `astro dev` children, real forked
// write executors, real loopback sockets; no DOM, no stand-ins.

/**
 * The K1 server-authority proof (#254): the real control-plane
 * composition — driven through the REAL wire by the shared A-B-A
 * harness (`./harness.ts`, the K-family's stable API) — is SAFE when
 * everything project A minted arrives after the switch to B and back
 * to a NEW generation of A. This file is the runtime-integration tier
 * (`packages/runtime/test/project-switch/`, the ticket's owned path);
 * the browser-driven slice lives at `apps/web/e2e/project-switch/`.
 *
 * The legs walk ONE serial session history (one composition, one
 * supervisor-global active session — the web battery's own discipline):
 *
 * 1. the A-B-A spine — A commits with live CSS/Content grants, an SSE
 *    stream, and an HMR tunnel; B switches; A returns at a fresh
 *    generation. Every retired truth is pinned dead at its own seam:
 *    the retired host 421s (HTTP and raw upgrade), the stream and the
 *    tunnel close, the stale pair is refused under LIVE authority
 *    (409), the dead binding and the dead capability are refused
 *    (403), and the stale CSS and Content grants write nothing under
 *    B's session nor under A's new generation (403 grant-rejected).
 *    The drained CSS write PERSISTS — the new generation serves the
 *    written truth.
 * 2. the fault tier — a precommit mutation whose head crosses while A
 *    is live but whose body completes only after the switch is refused
 *    fail-closed (the deferred admission re-derives the host) and
 *    mutates neither project.
 * 3. repeated switches — two more full A-B-A rounds: retired planes'
 *    real child pids converge to dead, the app-global edit-writer
 *    lease is released (each successor's first write forks and
 *    commits), the retired host stays 421, and the bytes oracle pins
 *    that NO wrong project ever mutated.
 * 4. the one-attempt law — a second activation through the wire during
 *    the in-flight window is refused 409 concurrent-activation and the
 *    in-flight attempt still lands (the receipt-adjacent generation
 *    fencing; the one-use receipt ledger itself is F6's unit-proven
 *    law, cited not re-proved). The winner's adoption is WHOLE (#412
 *    fixed: the refused request no longer wipes the in-flight
 *    candidate's run bookkeeping) — its inspects serve, its origin
 *    lease routes to the real dev server, and its plane dies at the
 *    deactivation, never past the composition's close. THIS LEG RUNS
 *    LAST.
 *
 * Everything asserted is wire-oracle truth (statuses, envelopes,
 * streams, sockets, file bytes, real pids) PLUS the supervisor's own
 * public snapshot — the commit oracle #411's poisoned envelopes force —
 * never private composition mechanics (seats, candidates, grant
 * tables). Grants and raw bytes are always CAPTURED while their
 * generation is live and replayed after the switch — a stale-authority
 * probe is never conditional on reaching a retired host.
 */

/** The write fact pair every stale-write replay needs. */
interface WriteFact {
  readonly grant: ResourceGrant;
  readonly raw: string;
}

/** Asserts one tree changed exactly at the named paths — never elsewhere. */
async function expectTreeExactly(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  expectedPaths: readonly string[],
): Promise<void> {
  const changed: string[] = [];
  for (const [path, sha] of after) {
    if (before.get(path) !== sha) changed.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.push(`${path} (removed)`);
  }
  expect(changed.sort()).toEqual([...expectedPaths].sort());
}

/** One raw upgrade attempt's bytes — the origin's own admission is the probe target, not vite's. */
function upgradeAttempt(hostname: string, port: number, origin: string): string {
  return [
    'GET /?token=anything HTTP/1.1',
    `Host: ${hostname}:${port}`,
    `Origin: ${origin}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Protocol: vite-hmr',
    '',
    '',
  ].join('\r\n');
}

/** A bare GET's bytes — the retired-host probe's own shape. */
function hostProbe(hostname: string, port: number): string {
  return [
    'GET /__astroix/app/ HTTP/1.1',
    `Host: ${hostname}:${port}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
}

/** The CSS write fact for one project's sheet — captured while its generation is live. */
async function cssWriteFact(harness: SwitchHarness, document: SwitchDocument): Promise<WriteFact> {
  const response = await harness.inspect({ kind: 'styles', route: '/' }, document);
  expect(response.status, response.body).toBe(200);
  const payload = JSON.parse(response.body) as {
    result: {
      result: { payload: { writeFacts?: { file: string; grant: ResourceGrant; raw: string }[] } };
    };
  };
  const fact = payload.result.result.payload.writeFacts?.find(
    (entry) => entry.file === document.project.cssPath,
  );
  if (fact === undefined) {
    throw new Error('the styles inspection carried no write fact for the sheet');
  }
  return { grant: fact.grant, raw: fact.raw };
}

/** The content write fact for one project's blog entry — captured while its generation is live. */
async function contentWriteFact(
  harness: SwitchHarness,
  document: SwitchDocument,
): Promise<WriteFact> {
  const response = await harness.inspect({ kind: 'content' }, document);
  expect(response.status, response.body).toBe(200);
  const payload = JSON.parse(response.body) as {
    result: {
      result: {
        payload: {
          collections?: {
            entries?: { filePath?: string; grant?: ResourceGrant; raw?: string }[];
          }[];
        };
      };
    };
  };
  for (const collection of payload.result.result.payload.collections ?? []) {
    const entry = (collection.entries ?? []).find(
      (candidate) => candidate.filePath === document.project.contentPath,
    );
    if (entry?.grant !== undefined && entry.raw !== undefined) {
      return { grant: entry.grant, raw: entry.raw };
    }
  }
  throw new Error('the content inspection carried no write fact for the blog entry');
}

/** The CSS splice plan — the frozen declaration write the web battery's own oracle mirrors. */
function cssSplicePlan(fact: WriteFact, fromValue: string, toValue: string): WritePlan {
  const anchor = `font-size: ${fromValue};`;
  const start = fact.raw.indexOf(anchor);
  if (start === -1) throw new Error(`the sheet lost the anchor "${anchor}"`);
  return {
    operation: 'splice',
    grant: fact.grant,
    range: { start, end: start + anchor.length },
    replacement: `font-size: ${toValue};`,
  };
}

/** One admitted CSS write through the wire, from a fresh captured fact. */
async function writeCss(
  harness: SwitchHarness,
  document: SwitchDocument,
  fromValue: string,
  toValue: string,
): Promise<{ status: number; body: string }> {
  const fact = await cssWriteFact(harness, document);
  return await harness.applyEdit(cssSplicePlan(fact, fromValue, toValue), document);
}

/** The error envelope's code — every refusal assertion reads the closed vocabulary. */
function errorCode(body: string): string {
  return (JSON.parse(body) as { error?: { code?: string } }).error?.code ?? 'none';
}

/** The sheet bytes on disk — the bytes oracle's direct read. */
async function sheetOf(project: SwitchProject): Promise<string> {
  return await readFile(`${project.root}/${project.cssPath}`, 'utf8');
}

/** The blog entry bytes on disk. */
async function entryOf(project: SwitchProject): Promise<string> {
  return await readFile(`${project.root}/${project.contentPath}`, 'utf8');
}

/**
 * The subtree's PLANE children — the worker and the managed dev server,
 * identified by their stable command markers. Counting by markers keeps
 * the oracle immune to this harness's own transient helpers: the `ps`
 * polls themselves appear as pre-exec `(node)` children while their
 * exec is in flight, so a raw child count flickers and can never settle.
 */
/** Whether one promise settled inside the budget — a probe, never a naked sleep. */
async function settledWithin(promise: Promise<unknown>, budgetMs: number): Promise<boolean> {
  return await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      globalThis.setTimeout(() => resolve(false), budgetMs);
    }),
  ]);
}

describe('the real control plane across A-B-A switching (K1 #254)', () => {
  const FIXTURE_SOURCES = fileURLToPath(new URL('../../../../e2e/fixture/src', import.meta.url));
  let harness: SwitchHarness;
  let treeA: ReadonlyMap<string, string>;
  let treeB: ReadonlyMap<string, string>;
  let fixtureSources: ReadonlyMap<string, string>;

  beforeAll(async () => {
    harness = await createSwitchHarness();
    treeA = await harness.tree(harness.projectA.root);
    treeB = await harness.tree(harness.projectB.root);
    fixtureSources = await harness.tree(FIXTURE_SOURCES);
  }, ACTIVATION_BUDGET_MS);

  afterAll(async () => {
    if (harness === undefined) return;
    await harness.close();
    // The canonical fixture is a read-only source (#254's migration
    // policy): the battery's staged writes may never reach it.
    await expectTreeExactly(fixtureSources, await harness.tree(FIXTURE_SOURCES), []);
    // Runner hygiene, never an assertion: a leg that fails mid-history
    // can leave plane children alive past the composition's close, so
    // reap exactly this process's leftovers to keep the runner clean
    // (#412's fix landed — the raced winner's run is registered and
    // stopped at close; this belt exists for a RED history, not a green
    // one).
    for (const pid of await planePids(harness)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone — the defect's leak is best-effort hygiene
      }
    }
  });

  it('commits A, switches to B, returns to A at a fresh generation — and every retired authority stays dead', {
    timeout: 480_000,
  }, async () => {
    // A1 commits: a live document, a live stream, a live tunnel, live grants.
    const a1 = await harness.activate(harness.projectA);
    expect(a1.document.session.generation).toBe(1);
    const sse: LiveProbe = await harness.openEvents(a1.document);
    await expect(sse.status).resolves.toBe(200);
    const hmr: LiveProbe = await harness.openHmr(a1.document);
    await expect(hmr.status).resolves.toBe(101);
    // the tunnel is LIVE — it survives a settle window, so the close
    // observed after the switch is the revocation's, never vite's timing
    expect(await settledWithin(hmr.closed, 2_000)).toBe(false);
    // the grants are CAPTURED here, while A1 is live.
    const a1Css = await cssWriteFact(harness, a1.document);
    const a1Content = await contentWriteFact(harness, a1.document);

    // the accepted CSS write: committed through the real write
    // executor, drained truth for whatever generation follows
    const write = await harness.applyEdit(cssSplicePlan(a1Css, '3rem', '3.5rem'), a1.document);
    expect(write.status).toBe(200);
    expect(errorCode(write.body)).toBe('none');
    expect(await sheetOf(harness.projectA)).toContain('font-size: 3.5rem;');
    // the live stream CARRIED the write's invalidation before any switch
    await pollUntil(async () => sse.frames().length > 0, SETTLE_BUDGET_MS);

    // B switches: A's authority dies at every seam.
    const b1 = await harness.activate(harness.projectB);
    expect(b1.document.project.key).not.toBe(a1.document.project.key);
    expect(
      (await rawExchange(harness.port, hostProbe(harness.projectA.hostname, harness.port))).status,
    ).toBe(421);
    expect(
      (
        await rawExchange(
          harness.port,
          upgradeAttempt(harness.projectA.hostname, harness.port, harness.projectA.origin),
        )
      ).status,
    ).toBe(421);
    expect(await settledWithin(sse.closed, SETTLE_BUDGET_MS)).toBe(true);
    expect(await settledWithin(hmr.closed, SETTLE_BUDGET_MS)).toBe(true);

    // the stale CSS grant writes NOTHING under B's session.
    const staleUnderB = await harness.applyEdit(cssSplicePlan(a1Css, '3rem', '9rem'), b1.document);
    expect(staleUnderB.status).toBe(403);
    expect(errorCode(staleUnderB.body)).toBe('grant-rejected');
    // A1's own document is unreachable now — its host is retired.
    expect((await harness.inspect({ kind: 'project' }, a1.document)).status).toBe(421);
    // the bytes oracle: A holds exactly the drained write; B is pristine.
    await expectTreeExactly(treeA, await harness.tree(harness.projectA.root), [
      harness.projectA.cssPath,
    ]);
    await expectTreeExactly(treeB, await harness.tree(harness.projectB.root), []);

    // A returns: a NEW generation, never a revival.
    const a2 = await harness.activate(harness.projectA);
    expect(a2.document.session.generation).toBeGreaterThan(a1.document.session.generation);
    expect(a2.document.session.runtimeEpoch).toBe(a1.document.session.runtimeEpoch);
    expect(a2.document.hostCapability).not.toBe(a1.document.hostCapability);
    expect(a2.document.clientCapability).not.toBe(a1.document.clientCapability);

    // B's host is the retired one now.
    expect(
      (await rawExchange(harness.port, hostProbe(harness.projectB.hostname, harness.port))).status,
    ).toBe(421);

    // A1's pair under A2's LIVE authority: stale (409).
    const stalePair = await harness.post(
      {
        protocolVersion: 1,
        requestId: 'stale-pair',
        session: a1.document.session,
        command: { kind: 'inspect', request: { kind: 'project' } },
      },
      {
        cookie: a2.document.hostCapability,
        client: a2.document.clientCapability,
        project: harness.projectA,
      },
    );
    expect(stalePair.status).toBe(409);
    expect(errorCode(stalePair.body)).toBe('stale-session');

    // A1's dead client binding and dead host capability: refused (403).
    const deadClient = await harness.post(
      {
        protocolVersion: 1,
        requestId: 'dead-client',
        session: a2.document.session,
        command: { kind: 'inspect', request: { kind: 'project' } },
      },
      {
        cookie: a2.document.hostCapability,
        client: a1.document.clientCapability,
        project: harness.projectA,
      },
    );
    expect(deadClient.status).toBe(403);
    expect(errorCode(deadClient.body)).toBe('unauthorized');
    const deadCookie = await harness.post(
      {
        protocolVersion: 1,
        requestId: 'dead-cookie',
        session: a2.document.session,
        command: { kind: 'inspect', request: { kind: 'project' } },
      },
      {
        cookie: a1.document.hostCapability,
        client: a2.document.clientCapability,
        project: harness.projectA,
      },
    );
    expect(deadCookie.status).toBe(403);
    expect(errorCode(deadCookie.body)).toBe('unauthorized');

    // A1's grants under A2's session: the new table never knew them —
    // CSS and Content alike, both verticals' stale authority dead.
    const staleCssUnderA2 = await harness.applyEdit(
      cssSplicePlan(a1Css, '3rem', '9rem'),
      a2.document,
    );
    expect(staleCssUnderA2.status).toBe(403);
    expect(errorCode(staleCssUnderA2.body)).toBe('grant-rejected');
    const staleContentUnderA2 = await harness.applyEdit(
      {
        operation: 'replace-contents',
        grant: a1Content.grant,
        contents: a1Content.raw.replace('title: Hello builder', 'title: Revived'),
      },
      a2.document,
    );
    expect(staleContentUnderA2.status).toBe(403);
    expect(errorCode(staleContentUnderA2.body)).toBe('grant-rejected');

    // A2's own inspection serves the DRAINED write (the normal-switch
    // law): the persisted 3.5rem is the new generation's truth.
    const fresh = await cssWriteFact(harness, a2.document);
    expect(fresh.raw).toContain('font-size: 3.5rem;');
    expect(await entryOf(harness.projectA)).not.toContain('Revived');
    await expectTreeExactly(treeA, await harness.tree(harness.projectA.root), [
      harness.projectA.cssPath,
    ]);
    await expectTreeExactly(treeB, await harness.tree(harness.projectB.root), []);
  });

  it('refuses a precommit mutation whose body completes after the switch — and mutates nothing', {
    timeout: 480_000,
  }, async () => {
    // A2 holds the stage; capture a content grant and hold the write mid-body.
    const a2 = await harness.projectDocument();
    const fact = await contentWriteFact(harness, a2);
    const contents = fact.raw.replace('title: Hello builder', 'title: Hello builder (delayed)');
    const envelope: RequestEnvelope = {
      protocolVersion: 1,
      requestId: 'delayed',
      session: a2.session,
      command: {
        kind: 'apply-edit',
        plan: { operation: 'replace-contents', grant: fact.grant, contents },
      },
    };
    const delayed = harness.openDelayedMutation(
      envelope,
      a2,
      Math.floor(JSON.stringify(envelope).length / 2),
    );

    // the switch happens underneath the held body.
    await harness.activate(harness.projectB);
    const finished = await delayed.finish();

    // fail-closed: the deferred admission re-derives the host against
    // the CURRENT routing truth — the request never reaches the
    // executor, and the closed vocabulary answers.
    expect(finished.status).toBe(404);
    expect(errorCode(finished.body)).toBe('resource-not-found');

    // neither project's bytes moved.
    expect(await entryOf(harness.projectA)).not.toContain('(delayed)');
    await expectTreeExactly(treeA, await harness.tree(harness.projectA.root), [
      harness.projectA.cssPath,
    ]);
    await expectTreeExactly(treeB, await harness.tree(harness.projectB.root), []);
  });

  it('converges processes, leases, and bytes across repeated switches', {
    timeout: 900_000,
  }, async () => {
    // the steady-state ledger: A's sheet holds the drained splice; B stays pristine.
    const expectSteady = async (): Promise<void> => {
      await expectTreeExactly(treeA, await harness.tree(harness.projectA.root), [
        harness.projectA.cssPath,
      ]);
      await expectTreeExactly(treeB, await harness.tree(harness.projectB.root), []);
    };

    // one more full A-B-A round (the file's history already walks two);
    // each generation's first write proves the app-global edit-writer
    // lease was released by its predecessor. The round count is also a
    // load statement: every activation boots a real dev server inside
    // the root vitest run's parallel pack, and the supervisor's fixed
    // startup deadline has no injectable bound.
    const sequence: SwitchProject[] = [harness.projectA, harness.projectB];
    let previousPlane: number[] = [];
    let steadySize = -1;
    for (const project of sequence) {
      const { document } = await harness.activate(project);
      if (steadySize === -1) {
        steadySize = (await planePids(harness)).length;
      } else {
        // resource-count convergence, the anti-leak law: at most one
        // live generation's plane children exist at once (the exact
        // steady count is pinned by the retired-pid law below and the
        // final drain-to-zero; under full-suite load a dying
        // predecessor's tail may briefly overlap the successor).
        await pollUntil(
          async () => (await planePids(harness)).length <= steadySize,
          SETTLE_BUDGET_MS,
        );
      }
      // the lease proof: this generation's first write forks and commits.
      const from = project === harness.projectA ? '3.5rem' : '3rem';
      const to = project === harness.projectA ? '3.75rem' : '3.25rem';
      expect((await writeCss(harness, document, from, to)).status).toBe(200);
      // and back to the steady value, so the ledger stays one splice.
      expect((await writeCss(harness, document, to, from)).status).toBe(200);
      expect(await sheetOf(project)).toContain(`font-size: ${from};`);

      // the previous generation's plane children are gone.
      if (previousPlane.length > 0) {
        const retired = previousPlane;
        await pollUntil(async () => {
          const alive = await planePids(harness);
          return retired.every((pid) => !alive.includes(pid));
        }, SETTLE_BUDGET_MS);
      }
      previousPlane = await planePids(harness);
      await expectSteady();
    }

    // the final deactivation: the last plane drains too.
    expect((await harness.deactivate()).status).toBe(200);
    await pollUntil(async () => (await planePids(harness)).length === 0, SETTLE_BUDGET_MS);

    // and the retired-host law held through the whole walk: idle means
    // the last project's host is retired as well.
    expect(
      (await rawExchange(harness.port, hostProbe(harness.projectB.hostname, harness.port))).status,
    ).toBe(421);
  });

  it('refuses a concurrent activation while the window is open — and the in-flight attempt still lands', {
    timeout: 480_000,
  }, async () => {
    const before = harness.snapshot().active?.ref.generation ?? 0;
    const inFlight = harness.activate(harness.projectA);
    await pollUntil(async () => harness.snapshot().attempt !== undefined, SETTLE_BUDGET_MS, 25);
    const launcher = await launcherDocument(harness.port);
    const race = await harness.post(
      {
        protocolVersion: 1,
        requestId: 'race',
        command: { kind: 'activate', projectKey: harness.projectA.key },
      },
      { cookie: launcher.cookie, client: launcher.client },
    );
    expect(race.status).toBe(409);
    expect(errorCode(race.body)).toBe('concurrent-activation');
    expect((JSON.parse(race.body) as { error?: { retryable?: boolean } }).error?.retryable).toBe(
      true,
    );

    // the supervisor-visible truths of the winner: reserved, committed,
    // active — and the winner's ADOPTION is whole (#412 fixed): the run
    // the in-flight attempt remembered survived the refused request's
    // path, so the seat dispatches real inspections and the origin
    // lease routes to the real dev-server port (the pre-fix corruption
    // answered 500 here and published upstream port -1).
    const landed = await inFlight;
    expect(landed.document.session.generation).toBeGreaterThan(before);
    const active = harness.snapshot().active;
    expect(active?.projectKey).toBe(harness.projectA.key);
    expect(active?.state).toBe('ready');
    const wholeInspect = await harness.inspect({ kind: 'project' }, landed.document);
    expect(wholeInspect.status, wholeInspect.body).toBe(200);
    const routed = await harness.fetchProxied(landed.document, '/@vite/client');
    expect(routed.status).toBe(200);

    // and the winner's plane never outlives its session: the
    // deactivation stops exactly the registered run — no orphaned
    // children past the transition (the pre-fix leak).
    expect((await harness.deactivate()).status).toBe(200);
    await pollUntil(async () => (await planePids(harness)).length === 0, SETTLE_BUDGET_MS);
  });
});
