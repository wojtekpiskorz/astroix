import { readFile } from 'node:fs/promises';
import type {
  RequestEnvelope,
  ResponseEnvelope,
  WritePlan,
} from '@wojciechpiskorz/astroix-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACTIVATION_BUDGET_MS,
  createSwitchHarness,
  launcherDocument,
  planePids,
  rawExchange,
  type StylesWriteFact,
  type SwitchHarness,
  type SwitchProject,
} from './harness.ts';

// @vitest-environment node — real managed `astro dev` children, real
// loopback sockets; no DOM, no stand-ins.

/**
 * The K2 client-reset battery — the runtime tier (#255): the two wire
 * faces the client contract models that K1's spine did not carry, both
 * over the SHARED A-B-A harness (`./harness.ts`, the K-family's stable
 * surface, extended by this lane with `stylesWriteFact`):
 *
 * 1. the CSS vertical's held-body fault face (the #417 review's
 *    deferred leg): K1 proved the delayed-mutation refusal on Content
 *    only — the CSS vertical's delayed face was immediate-replay-only
 *    (the stale grant's 403). This leg holds a CSS SPLICE mutation's
 *    body across the transition boundary and proves the same
 *    fail-closed law on the styles lane: the deferred admission
 *    re-derives the host against the CURRENT routing truth, the
 *    request never reaches the executor, and neither project's bytes
 *    move.
 * 2. the idempotent re-activation's drain-window disclosure (#413's
 *    modeling over #419's wired discipline): a same-project activate
 *    that lands while a deactivation is TEARING DOWN answers the
 *    idempotent 200 — the CURRENT pair, no generation bump, nothing
 *    staged — and the deactivate envelope follows: the teardown
 *    proceeds, the session dies, and the pair the 200 carried is dead
 *    by the time anyone consumes it (the retired host's 421). The
 *    client contract this pins: an activation envelope's 200 is never
 *    by itself a switch — only the PAIR it carries is currency, and a
 *    pair can die underneath a 200 that answered it.
 *
 * SERIAL like the K-family's own batteries: one composition, one
 * supervisor-global active session — the legs walk one history (A
 * active → the held CSS write refused under B → B active → the
 * drain-window interleave → idle) and touch no bytes that ever commit.
 */

/** The error envelope's code — every refusal assertion reads the closed vocabulary. */
function errorCode(body: string): string {
  return (JSON.parse(body) as { error?: { code?: string } }).error?.code ?? 'none';
}

/** The CSS splice plan — the frozen declaration write over a captured live fact. */
function cssDeclarationSplice(
  fact: StylesWriteFact,
  fromValue: string,
  toValue: string,
): WritePlan {
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

/** The sheet bytes on disk — the bytes oracle's direct read. */
async function sheetOf(project: SwitchProject): Promise<string> {
  return await readFile(`${project.root}/${project.cssPath}`, 'utf8');
}

describe('the client-reset wire faces across A-B-A switching (K2 #255)', () => {
  let harness: SwitchHarness;
  let sheetABefore: string;
  let sheetBBefore: string;

  beforeAll(async () => {
    harness = await createSwitchHarness();
    sheetABefore = await sheetOf(harness.projectA);
    sheetBBefore = await sheetOf(harness.projectB);
  }, ACTIVATION_BUDGET_MS);

  afterAll(async () => {
    if (harness === undefined) return;
    await harness.close();
    // Runner hygiene, never an assertion (the K-family's shared belt): a
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

  it('refuses a held-body CSS splice whose body completes after the switch — and mutates nothing', {
    timeout: 480_000,
  }, async () => {
    // A1 commits; the styles write fact is captured while its
    // generation is live (the harness member's own admission).
    const a1 = await harness.activate(harness.projectA);
    const fact = await harness.stylesWriteFact(a1.document);
    expect(fact.raw).toContain('font-size: 3rem;');
    const envelope: RequestEnvelope = {
      protocolVersion: 1,
      requestId: 'css-held',
      session: a1.document.session,
      command: {
        kind: 'apply-edit',
        plan: cssDeclarationSplice(fact, '3rem', '9rem'),
      },
    };
    const delayed = harness.openDelayedMutation(
      envelope,
      a1.document,
      Math.floor(JSON.stringify(envelope).length / 2),
    );

    // the switch happens underneath the held body.
    await harness.activate(harness.projectB);
    const finished = await delayed.finish();

    // fail-closed on the styles lane exactly as on the content lane:
    // the deferred admission re-derives the host against the CURRENT
    // routing truth — A's host is retired, the request never reaches
    // the executor, and the closed vocabulary answers.
    expect(finished.status, finished.body).toBe(404);
    expect(errorCode(finished.body)).toBe('resource-not-found');

    // neither project's bytes moved — the refusal wrote nothing.
    expect(await sheetOf(harness.projectA)).toBe(sheetABefore);
    expect(await sheetOf(harness.projectB)).toBe(sheetBBefore);
  });

  it('answers a same-project activate inside the deactivation window idempotently — and the teardown proceeds past it', {
    timeout: 480_000,
  }, async () => {
    // B holds the stage (leg 1 switched to it); its deactivation is
    // held mid-body — admitted only when the body completes, so the
    // supervisor still sees B's session as the active one.
    const document = await harness.projectDocument();
    const seated = harness.snapshot().active;
    expect(seated?.projectKey).toBe(harness.projectB.key);
    expect(seated?.state).toBe('ready');
    const envelope: RequestEnvelope = {
      protocolVersion: 1,
      requestId: 'held-deactivate',
      session: document.session,
      command: { kind: 'deactivate' },
    };
    const held = harness.openDelayedMutation(
      envelope,
      document,
      Math.floor(JSON.stringify(envelope).length / 2),
    );

    // The drain-window disclosure's exact shape: a same-project
    // activate arrives while the teardown is pending. It answers the
    // IDEMPOTENT 200 — the CURRENT pair, no generation bump, nothing
    // staged — never a concurrent-activation refusal and never a fresh
    // generation.
    const launcher = await launcherDocument(harness.port);
    const during = await harness.post(
      {
        protocolVersion: 1,
        requestId: 'drain-idempotent',
        command: { kind: 'activate', projectKey: harness.projectB.key },
      },
      { cookie: launcher.cookie, client: launcher.client },
    );
    expect(during.status, during.body).toBe(200);
    const idempotent = JSON.parse(during.body) as ResponseEnvelope;
    if (idempotent.result.kind !== 'activation') {
      throw new Error(
        `the drain-window activate answered ${idempotent.result.kind} — a wire defect`,
      );
    }
    expect(idempotent.result.target.projectKey).toBe(harness.projectB.key);
    expect(idempotent.result.target.session.generation).toBe(seated?.ref.generation);
    expect(idempotent.result.snapshot.active?.state).toBe('ready');
    expect(idempotent.result.snapshot.attempt).toBeUndefined();
    expect(idempotent.result.snapshot.lastFailure).toBeUndefined();

    // The deactivate envelope FOLLOWS: the held body completes, the
    // teardown proceeds through the idempotent 200 that answered
    // around it, and the transition settles clean.
    const finished = await held.finish();
    expect(finished.status, finished.body).toBe(200);
    const stopped = JSON.parse(finished.body) as ResponseEnvelope;
    if (stopped.result.kind !== 'deactivation') {
      throw new Error(`the held deactivation answered ${stopped.result.kind} — a wire defect`);
    }
    expect(stopped.result.snapshot.active).toBeUndefined();
    expect(stopped.result.snapshot.lastFailure).toBeUndefined();

    // The pair the idempotent 200 carried is DEAD by the time anyone
    // consumes it: the host is retired and the document-shaped use of
    // that pair answers the retired-origin refusal — the client
    // contract's belt (a 200 is currency only through the pair it
    // carries, and pairs die).
    const retired = await rawExchange(
      harness.port,
      [
        'GET /__astroix/app/ HTTP/1.1',
        `Host: ${harness.projectB.hostname}:${harness.port}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'),
    );
    expect(retired.status).toBe(421);
    expect(harness.snapshot().active).toBeUndefined();

    // And nothing the interleave touched ever reached disk.
    expect(await sheetOf(harness.projectA)).toBe(sheetABefore);
    expect(await sheetOf(harness.projectB)).toBe(sheetBBefore);
  });
});
