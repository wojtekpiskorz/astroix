import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ProjectKey,
  PublicError,
  RequestEnvelope,
  ResponseEnvelope,
  SessionRef,
  WritePlan,
} from '@wojciechpiskorz/astroix-protocol';
import type { ClientBindings } from '@wojciechpiskorz/astroix-runtime/api/http';
import type { DocumentAuthority } from '@wojciechpiskorz/astroix-runtime/client-authority';
import type { WriteExecutorHandle } from '@wojciechpiskorz/astroix-runtime/edit-authority/executor';
import type { GrantTable } from '@wojciechpiskorz/astroix-runtime/edit-authority/grants';
import { createGrantTable } from '@wojciechpiskorz/astroix-runtime/edit-authority/grants';
import type { OriginLease, OriginListener } from '@wojciechpiskorz/astroix-runtime/origin';
import type { ProjectRun } from '@wojciechpiskorz/astroix-runtime/project-runtime';
import type { ProjectRegistry } from '@wojciechpiskorz/astroix-runtime/registry';
import type { SessionClients } from '@wojciechpiskorz/astroix-runtime/session-supervisor/clients';
import type { SwitchCoordinator } from '@wojciechpiskorz/astroix-runtime/session-supervisor/commit';
import type { SessionCompletion } from '@wojciechpiskorz/astroix-runtime/session-supervisor/completion';
import { createEditFence } from '@wojciechpiskorz/astroix-runtime/session-supervisor/fence';
import type { SessionSupervisor } from '@wojciechpiskorz/astroix-runtime/session-supervisor/staging';
import type { SseHub } from '@wojciechpiskorz/astroix-runtime/sse';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type EditFixtureName,
  editFixtureSchemas,
} from '../../../e2e/behavior-contracts/schema/edit-contract.ts';
import { pairKey } from './candidates.ts';
import { createExecutor, type ExecutorInputs, type SessionSeat } from './executor.ts';

// @vitest-environment node — forks the real write-executor child from real file paths; no DOM.

/**
 * The grant-bound Content write composition (#253's executor
 * integration legs): the REAL web-host executor over the REAL D4 grant
 * table + planning boundary and the REAL D5 write-executor child
 * (forked, kernel-leased, atomic) — asserted on the FILE BYTES the
 * frozen edit contracts froze, never on internals. The untouched
 * executor inputs (supervisor, coordinator, completion, …) are inert
 * stubs: `apply-edit` and `inspect` never reach them, and the
 * stranded-adoption battery (executor.test.ts) owns their real wiring.
 */

const SESSION: SessionRef = { runtimeEpoch: 'epoch-apply-edit', generation: 1 };
const OTHER_SESSION: SessionRef = { runtimeEpoch: 'epoch-apply-edit', generation: 2 };
const PROJECT: ProjectKey = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Loads one frozen edit fixture through its versioned contract schema (the corpus's own gate). */
function editFixture<K extends EditFixtureName>(name: K) {
  const raw = JSON.parse(
    readFileSync(
      join(__dirname, '..', '..', '..', 'e2e', 'behavior-contracts', 'edit', name),
      'utf8',
    ),
  ) as unknown;
  const parsed = editFixtureSchemas[name].safeParse(raw);
  if (!parsed.success) throw new Error(`frozen fixture ${name} drifted: ${parsed.error.message}`);
  return parsed.data as (typeof editFixtureSchemas)[K]['_output'];
}

/** One real temp project root carrying the frozen frontmatter-write fixture's file. */
async function makeProject(): Promise<{ root: string; table: GrantTable }> {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'astroix-apply-edit-')));
  scratchDirs.push(scratch);
  const root = join(scratch, 'project');
  const contract = editFixture('content-frontmatter-write.json');
  await mkdir(dirname(join(root, contract.file)), { recursive: true });
  await writeFile(join(root, contract.file), contract.baseline.contents, 'utf8');
  const table = await createGrantTable(root);
  return { root, table };
}

/** The inert stubs — typed as the interfaces demand, reached by no apply-edit or inspect path. */
function inertInputs(): Pick<
  ExecutorInputs,
  | 'supervisor'
  | 'coordinator'
  | 'completion'
  | 'authority'
  | 'listener'
  | 'sessionClients'
  | 'httpBindings'
  | 'hub'
> {
  return {
    supervisor: null as unknown as SessionSupervisor,
    coordinator: null as unknown as SwitchCoordinator,
    completion: null as unknown as SessionCompletion,
    authority: null as unknown as DocumentAuthority,
    listener: null as unknown as OriginListener,
    sessionClients: null as unknown as SessionClients,
    httpBindings: null as unknown as ClientBindings,
    hub: null as unknown as SseHub,
  };
}

/** The minimal real harness: one adopted seat over a real fence and the real table. */
async function makeExecutor(input?: {
  readonly runInspect?: ProjectRun['inspect'];
  /** Pre-seeds the retained write executor — the outcome-mapping legs' scripted child. */
  readonly writeExecutor?: WriteExecutorHandle;
  /** The per-edit outcome await's bound — the lifecycle legs' tight deadline (#391). */
  readonly editOutcomeDeadlineMs?: number;
}): Promise<{
  execute(envelope: RequestEnvelope): Promise<ResponseEnvelope | PublicError>;
  table: GrantTable;
  root: string;
  /** The retained-executor table — the eviction legs' observation point. */
  writeExecutors: Map<string, WriteExecutorHandle>;
}> {
  const { root, table } = await makeProject();
  const seat: SessionSeat = {
    ref: SESSION,
    projectKey: PROJECT,
    run: {
      ready: Promise.resolve(),
      inspect:
        input?.runInspect ?? (() => Promise.reject(new Error('no inspection is scripted here'))),
      subscribe: () => () => {},
      stop: () => Promise.resolve(null),
      closed: Promise.resolve(null),
    } as unknown as ProjectRun,
    devServerPort: 4310,
    lease: null as unknown as OriginLease,
    fence: createEditFence(),
    editorCapability: 'editor-capability-fixture',
    document: { webContentsId: 1, navigationId: 1 },
    clientCapability: 'client-capability-fixture',
  };
  const seats = new Map<string, SessionSeat>([[pairKey(SESSION), seat]]);
  const inputs: ExecutorInputs = {
    registry: {
      snapshot: () => ({
        status: 'ok',
        records: [{ projectKey: PROJECT, canonicalRoot: root, displayName: 'fixture project' }],
        quarantine: null,
      }),
      execute: async () => ({ ok: false, code: 'closed', message: 'inert' }),
      projectSummaries: async () => ({ ok: true, summaries: [] }),
      close: async () => {},
    } as unknown as ProjectRegistry,
    seatStore: {
      active: () => seats.get(pairKey(SESSION)) ?? null,
      adopt: () => {},
      drop: () => {},
    },
    grantTables: new Map<string, GrantTable>([[pairKey(SESSION), table]]),
    writeExecutors:
      input?.writeExecutor === undefined
        ? new Map()
        : new Map([[pairKey(SESSION), input.writeExecutor]]),
    privateStateDirectory: join(root, '..', 'private-state'),
    editRevisions: new Map<string, number>(),
    ...(input?.editOutcomeDeadlineMs === undefined
      ? {}
      : { editOutcomeDeadlineMs: input.editOutcomeDeadlineMs }),
    pendingDevPorts: [],
    freePort: async () => 4311,
    candidates: {
      remember: () => {},
      runOf: () => null,
      portOf: () => 4310,
      clear: () => {},
    } as unknown as ExecutorInputs['candidates'],
    ...inertInputs(),
  };
  await mkdir(inputs.privateStateDirectory, { recursive: true });
  return {
    execute: createExecutor(inputs).execute,
    table,
    root,
    writeExecutors: inputs.writeExecutors,
  };
}

/** One apply-edit request envelope over a wire plan. */
function editEnvelope(plan: WritePlan, session: SessionRef = SESSION): RequestEnvelope {
  return {
    protocolVersion: 1,
    requestId: 'req-1',
    session,
    command: { kind: 'apply-edit', plan },
  };
}

/** Issues one existing-text grant over the discovered facts. */
async function issueGrant(
  table: GrantTable,
  path: string,
  revision: string,
  session: SessionRef = SESSION,
  kind: 'content' | 'css' = 'content',
) {
  const granted = await table.issue({ discovery: 'existing-text', kind, path, revision }, session);
  if (!granted.ok) throw new Error(`grant issuance failed: ${granted.code}`);
  return granted.grant;
}

describe('the grant-bound content write composition', () => {
  it('lands the frozen contract bytes through the real executor child, atomically and byte-exact', async () => {
    const harness = await makeExecutor();
    const contract = editFixture('content-frontmatter-write.json');
    const grant = await issueGrant(harness.table, contract.file, contract.baseline.hash);
    const outcome = await harness.execute(
      editEnvelope({ operation: 'replace-contents', grant, contents: contract.written.contents }),
    );
    // the wire answer: the edit result with its monotonic revision and
    // the follow-on grant bound to the LANDED bytes' SHA
    expect(outcome).toEqual({
      protocolVersion: 1,
      requestId: 'req-1',
      session: SESSION,
      result: {
        kind: 'edit',
        result: {
          revision: 1,
          nextGrant: expect.objectContaining({
            kind: 'content',
            baseline: { type: 'sha256', sha256: contract.after.hash },
          }),
        },
      },
    });
    // THE freeze: the file on disk is the contract's after-bytes
    expect(await readFile(join(harness.root, contract.file), 'utf8')).toBe(contract.after.contents);
  }, 30_000);

  it('writes NOTHING on a pre-commit failure — a raced disk keeps its interference bytes and hands back the current SHA', async () => {
    const harness = await makeExecutor();
    const contract = editFixture('content-conflict.json');
    // the conflict contract's baseline is the PREVIOUS write's after —
    // stage it, issue against it, then race the disk under the grant
    await writeFile(join(harness.root, contract.file), contract.baseline.contents, 'utf8');
    const grant = await issueGrant(harness.table, contract.file, contract.baseline.hash);
    await writeFile(join(harness.root, contract.file), contract.interference.contents, 'utf8');
    const outcome = await harness.execute(
      editEnvelope({
        operation: 'replace-contents',
        grant,
        // the union schema types the css-splice legs' optional fields;
        // the content-write leg always carries `contents`
        contents: contract.attempt.contents ?? '',
      }),
    );
    // the sanitized conflict: 409-shaped refusal naming the disk truth
    expect(outcome).toEqual({
      code: 'revision-conflict',
      message: expect.any(String),
      retryable: false,
      details: { currentSha256: sha256Of(contract.interference.contents) },
    });
    // unchanged bytes: the interference survived the refused write
    expect(await readFile(join(harness.root, contract.file), 'utf8')).toBe(
      contract.interference.contents,
    );
  }, 30_000);

  it('refuses a stale-session envelope before any table or executor work', async () => {
    const harness = await makeExecutor();
    const contract = editFixture('content-frontmatter-write.json');
    const grant = await issueGrant(harness.table, contract.file, contract.baseline.hash);
    const outcome = await harness.execute(
      editEnvelope(
        { operation: 'replace-contents', grant, contents: contract.written.contents },
        OTHER_SESSION,
      ),
    );
    expect(outcome).toEqual({
      code: 'stale-session',
      message: expect.any(String),
      retryable: false,
    });
  });

  it('refuses a superseded grant as revoked — the table never accepts a dead token', async () => {
    const harness = await makeExecutor();
    const contract = editFixture('content-frontmatter-write.json');
    const first = await issueGrant(harness.table, contract.file, contract.baseline.hash);
    // a later issuance over the same target evicts the first token
    await issueGrant(harness.table, contract.file, contract.baseline.hash);
    const outcome = await harness.execute(
      editEnvelope({
        operation: 'replace-contents',
        grant: first,
        contents: contract.written.contents,
      }),
    );
    expect(outcome).toEqual({
      code: 'grant-rejected',
      message: expect.any(String),
      retryable: false,
      details: { reason: 'revoked' },
    });
    expect(await readFile(join(harness.root, contract.file), 'utf8')).toBe(
      contract.baseline.contents,
    );
  }, 30_000);

  it('enriches the content inspection with the write facts (grant + raw text, bound to the inspected revision)', async () => {
    const contract = editFixture('content-frontmatter-write.json');
    const payload = {
      collections: [
        {
          name: 'blog',
          entries: [
            {
              id: '2024/post',
              filePath: contract.file,
              data: { title: 'Nested post' },
              body: 'the body',
              revision: contract.baseline.hash,
              issues: [],
            },
            {
              id: 'store-entry',
              filePath: null,
              data: {},
              body: null,
              revision: null,
              issues: null,
            },
          ],
          schema: { declared: true, fields: [] },
          revision: 'c'.repeat(64),
        },
      ],
      diagnostics: [],
      revision: 'd'.repeat(64),
    };
    const harness = await makeExecutor({
      runInspect: () =>
        // the staged file IS the contract baseline — the enrichment's
        // freshness proof holds by construction
        Promise.resolve({
          kind: 'content' as const,
          revision: 1,
          payload,
        }),
    });
    const outcome = await harness.execute({
      protocolVersion: 1,
      requestId: 'req-2',
      session: SESSION,
      command: { kind: 'inspect', request: { kind: 'content' } },
    });
    expect(outcome).not.toHaveProperty('code');
    const result = (outcome as ResponseEnvelope).result;
    expect(result.kind).toBe('inspection');
    if (result.kind !== 'inspection') throw new Error('unreachable');
    const enriched = result.result.payload as {
      collections: { entries: { id: string; grant?: unknown; raw?: unknown }[] }[];
    };
    const fileEntry = enriched.collections[0]?.entries.find((entry) => entry.id === '2024/post');
    // the grant: opaque, content-kind, bound to the inspected revision
    expect(fileEntry?.grant).toEqual(
      expect.objectContaining({
        kind: 'content',
        baseline: { type: 'sha256', sha256: contract.baseline.hash },
      }),
    );
    // the raw text: the file's bytes — the serializer's anchor
    expect(fileEntry?.raw).toBe(contract.baseline.contents);
    // the file-less entry stays honestly un-enriched
    const storeEntry = enriched.collections[0]?.entries.find((entry) => entry.id === 'store-entry');
    expect(storeEntry?.grant).toBeUndefined();
    expect(storeEntry?.raw).toBeUndefined();
  }, 30_000);

  it('maps the style planner’s range-outside-baseline onto the conflict class with the disk SHA — never the catch-all', async () => {
    const harness = await makeExecutor();
    // a real CSS resource: staged, hashed, granted through the real table
    const cssPath = 'src/styles/main.css';
    const cssText = 'body { color: red; }\n';
    await mkdir(dirname(join(harness.root, cssPath)), { recursive: true });
    await writeFile(join(harness.root, cssPath), cssText, 'utf8');
    const grant = await issueGrant(harness.table, cssPath, sha256Of(cssText), SESSION, 'css');
    // a splice range beyond the verified baseline contents: incoherent
    // with the revision contract — a DEFINITE non-write, and the closed
    // table must answer the conflict class (SHA handback), never the
    // internal-error catch-all (which the client would misread as
    // post-commit uncertainty)
    const outcome = await harness.execute(
      editEnvelope({
        operation: 'splice',
        grant,
        range: { start: 0, end: cssText.length + 10 },
        replacement: 'body { color: blue; }',
      }),
    );
    expect(outcome).toEqual({
      code: 'revision-conflict',
      message: expect.any(String),
      retryable: false,
      details: { currentSha256: sha256Of(cssText) },
    });
    // unchanged bytes: the incoherent plan wrote nothing
    expect(await readFile(join(harness.root, cssPath), 'utf8')).toBe(cssText);
  }, 30_000);

  it('maps the executor’s admission-time rejections through the closed table — fenced is retryable, malformed-plan is the malformed refusal, the range proof conflicts', async () => {
    // One scripted executor child (the injected handle the composition
    // retains): each dispatch's terminal rejection flows through the
    // REAL outcome mapping — the rows these legs pin live in the table,
    // not in a spawned child's world.
    const scripted: { outcome: Awaited<ReturnType<WriteExecutorHandle['execute']>> } = {
      outcome: { type: 'rejected', code: 'fenced', message: 'fenced' },
    };
    const stub: WriteExecutorHandle = {
      ready: Promise.resolve(),
      execute: () => Promise.resolve(scripted.outcome),
      stop: async () => {},
      kill: async () => {},
      exited: new Promise(() => {}),
    };
    const harness = await makeExecutor({ writeExecutor: stub });
    const contract = editFixture('content-frontmatter-write.json');
    const grant = await issueGrant(harness.table, contract.file, contract.baseline.hash);

    // fenced: the executor never ACCEPTED the work — the retryable
    // drain answer, never the catch-all's post-commit uncertainty
    const fenced = await harness.execute(
      editEnvelope({ operation: 'replace-contents', grant, contents: contract.written.contents }),
    );
    expect(fenced).toEqual({
      code: 'concurrent-activation',
      message: expect.any(String),
      retryable: true,
    });

    // malformed-plan: the dispatch failed the executor's closed shape
    // validation — the malformed-request refusal
    scripted.outcome = { type: 'rejected', code: 'malformed-plan', message: 'malformed' };
    const malformed = await harness.execute(
      editEnvelope({ operation: 'replace-contents', grant, contents: contract.written.contents }),
    );
    expect(malformed).toEqual({
      code: 'malformed-request',
      message: expect.any(String),
      retryable: false,
      details: { issue: 'invalid-shape', pointer: 'command.plan' },
    });

    // range-outside-baseline at final validation: the conflict class
    // with the disk-truth SHA handback (the baseline is untouched)
    scripted.outcome = {
      type: 'rejected',
      code: 'range-outside-baseline',
      message: 'range',
    };
    const outside = await harness.execute(
      editEnvelope({ operation: 'replace-contents', grant, contents: contract.written.contents }),
    );
    expect(outside).toEqual({
      code: 'revision-conflict',
      message: expect.any(String),
      retryable: false,
      details: { currentSha256: contract.baseline.hash },
    });
    expect(await readFile(join(harness.root, contract.file), 'utf8')).toBe(
      contract.baseline.contents,
    );
  }, 30_000);

  it('bounds a hung executor at the deadline — the uncertainty answer, the child disposed and evicted (#391)', async () => {
    // The hung child: alive, holding the dispatch, never answering —
    // the shape that used to hang the HTTP response past every bound
    let kills = 0;
    const hung: WriteExecutorHandle = {
      ready: Promise.resolve(),
      execute: () => new Promise(() => {}),
      stop: async () => {},
      kill: async () => {
        kills += 1;
      },
      exited: new Promise(() => {}),
    };
    const harness = await makeExecutor({ writeExecutor: hung, editOutcomeDeadlineMs: 25 });
    const contract = editFixture('content-frontmatter-write.json');
    const grant = await issueGrant(harness.table, contract.file, contract.baseline.hash);
    const started = Date.now();
    const outcome = await harness.execute(
      editEnvelope({ operation: 'replace-contents', grant, contents: contract.written.contents }),
    );
    // The bounded failure tail: the response settles at the bound, not
    // at the child's terminality — and the timeout maps through the
    // bounded-drain vocabulary's failure fold, the same closed
    // catch-all the `unknown` outcome gets (the client's post-commit
    // uncertainty state, never a guess)
    expect(Date.now() - started).toBeLessThan(5000);
    expect(outcome).toEqual({
      code: 'internal-error',
      message: 'the request could not be completed',
      retryable: false,
    });
    // The hung child is disposed: killed once (the D5 force path —
    // unsettled work resolves `unknown`, exactly the uncertainty the
    // response reported) and evicted from the retained table, so the
    // next accepted edit respawns instead of inheriting the wedge
    expect(kills).toBe(1);
    expect(harness.writeExecutors.has(pairKey(SESSION))).toBe(false);
    // Nothing landed: the plan never reached a live executor world
    expect(await readFile(join(harness.root, contract.file), 'utf8')).toBe(
      contract.baseline.contents,
    );
  }, 30_000);

  it('evicts a crashed executor and lazily respawns on the next write — no session-wide fail-closed (#391)', async () => {
    // The scripted child mimics the real handle's own exit discipline:
    // the dispatch hangs until the crash, and the crash resolves the
    // unsettled op `unknown` while `exited` settles — the composition's
    // eviction observes the exit, the next write forks a REAL child
    const pending: Array<(outcome: Awaited<ReturnType<WriteExecutorHandle['execute']>>) => void> =
      [];
    let crash: () => void = () => {};
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        crash = () => resolve({ code: 76, signal: null });
      },
    );
    const scripted: WriteExecutorHandle = {
      ready: Promise.resolve(),
      execute: () => new Promise((resolve) => pending.push(resolve)),
      stop: async () => {},
      kill: async () => {},
      exited,
    };
    const harness = await makeExecutor({ writeExecutor: scripted });
    const contract = editFixture('content-frontmatter-write.json');
    const grant = await issueGrant(harness.table, contract.file, contract.baseline.hash);

    const first = harness.execute(
      editEnvelope({ operation: 'replace-contents', grant, contents: contract.written.contents }),
    );
    // The planning boundary reads the WORLD (the revision contract's
    // proof against the disk) before the dispatch — a macrotask — so
    // the leg spins until the dispatch is actually in the child
    while (pending.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    crash();
    for (const resolve of pending.splice(0)) resolve({ type: 'unknown' });
    // The crashed write answers the honest uncertainty: no bytes were
    // proven landed by that response
    expect(await first).toEqual({
      code: 'internal-error',
      message: 'the request could not be completed',
      retryable: false,
    });
    // The observed exit evicted the dead handle — the fail-closed
    // session wedge is gone
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.writeExecutors.has(pairKey(SESSION))).toBe(false);

    // The next write lazily respawns: a REAL executor child forks,
    // takes the lease the crash released, and lands the contract bytes
    const second = await harness.execute(
      editEnvelope({ operation: 'replace-contents', grant, contents: contract.written.contents }),
    );
    expect(second).toEqual({
      protocolVersion: 1,
      requestId: 'req-1',
      session: SESSION,
      result: {
        kind: 'edit',
        result: { revision: 1, nextGrant: expect.objectContaining({ kind: 'content' }) },
      },
    });
    expect(await readFile(join(harness.root, contract.file), 'utf8')).toBe(contract.after.contents);
  }, 30_000);
});
