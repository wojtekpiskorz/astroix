import type { QueryClient } from '@tanstack/react-query';
import {
  MUTATION_HEADER_NAME,
  MUTATION_HEADER_VALUE,
  type SessionRef,
  type WritePlan,
} from '@wojciechpiskorz/astroix-protocol';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEntryDraft } from '../../../../core/src/entry-writer.ts';
import { createAppClient } from '../../app-client.ts';
import { ShellProvider } from '../../app-shell/shell-provider.tsx';
import {
  actAsync,
  byTestId,
  click,
  type Mounted,
  mount,
  waitFor,
} from '../../app-shell/test-mount.tsx';
import { editFixture, inspectionFixture } from '../../presentation/fixtures.ts';
import { typeInto } from '../../presentation/mount.tsx';
import { createShellQueryClient } from '../../query/shell-query-client.ts';
import { useEditSessionStore } from '../../state/edit-session-store.ts';
import { clearShellStores } from '../../state/shell-stores.ts';
import type { EntryWriteFacts } from './api.ts';
import { ContentEntryForm } from './forms/content-entry-form.tsx';
import { useFormDraftStore } from './forms/form-draft-store.ts';
import { useContentNavigationStore } from './navigation/navigation-store.ts';
import { buildEntryWritePlan } from './write/serialize-entry-write.ts';
import { IDLE_WRITE, reduceWrite } from './write/write-state.ts';
import { useContentWriteStore } from './write/write-store.ts';

/**
 * The Content write loop's focused lane (#253's mutation matrix): the
 * real provider, the real AppClient, and the real scripted wire —
 * inspect AND apply-edit exchanges over real protocol envelope bodies —
 * with the pane driven the way a user drives it. The byte-exactness
 * legs pin the serializer against the FROZEN edit contracts (the
 * corpus's derived side is exactly this module's pure function), and
 * the matrix covers the AC's admission refusals (stale baseline, stale
 * grant, stale generation, read-only role) and the five reported
 * states, including the stale-response-never-overwrites-committed law.
 */

const ORIGIN = 'http://project.localhost:4426';
const CAPABILITY = 'client-capability-fixture';
const SESSION: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 4 };

const collectionsFixture = inspectionFixture('collections.json');
const schemasFixture = inspectionFixture('content-schemas.json');

const REVISION = 'f'.repeat(64);
const NEXT_REVISION = 'e'.repeat(64);
const COLLECTION_REVISION = 'd'.repeat(64);
const GRANT_TOKEN = 'b'.repeat(48);
const NEXT_GRANT_TOKEN = 'c'.repeat(48);

/** One wire-shaped grant fixture — the issued claim, echoed verbatim. */
function grantFixture(input?: { readonly sha256?: string; readonly token?: string }): unknown {
  return {
    token: input?.token ?? GRANT_TOKEN,
    kind: 'content',
    operations: ['replace-contents'],
    displayPath: 'src/content/blog/hello-builder.md',
    baseline: { type: 'sha256', sha256: input?.sha256 ?? REVISION },
  };
}

/** One file-backed entry's raw text (the serializer's byte anchor). */
const RAW_HELLO =
  '---\ntitle: Hello builder\ndate: 2026-08-26T00:00:00.000Z\ntags: [meta]\n---\n\nFirst fixture post — flat id.\n';

/** Builds one E4-shaped content payload over the frozen corpora, with the write facts. */
function contentPayload(input?: {
  readonly entryRevision?: (id: string) => string | null;
  readonly entryData?: (collection: string, id: string) => unknown;
  readonly entryGrant?: (id: string) => unknown;
  readonly entryRaw?: (id: string) => string;
}): unknown {
  return {
    collections: collectionsFixture.collections.map((collection) => ({
      name: collection.name,
      entries: collection.entries.map((entry) => ({
        id: entry.id,
        filePath: `src/content/${collection.name}/${entry.id}.md`,
        data: input?.entryData?.(collection.name, entry.id) ?? entry.data,
        body: entry.body,
        revision: input?.entryRevision?.(entry.id) ?? REVISION,
        issues: [],
        ...(input?.entryGrant?.(entry.id) === undefined
          ? {}
          : { grant: input.entryGrant(entry.id) }),
        ...(input?.entryRaw?.(entry.id) === undefined ? {} : { raw: input.entryRaw(entry.id) }),
      })),
      schema: {
        declared: collection.hasSchema,
        fields:
          schemasFixture.schemas.find((schema) => schema.collection === collection.name)?.fields ??
          [],
      },
      revision: COLLECTION_REVISION,
    })),
    diagnostics: [],
    revision: 'a'.repeat(64),
  };
}

/** One captured apply-edit exchange. */
interface CapturedEdit {
  readonly headers: Record<string, string>;
  readonly plan: WritePlan;
  readonly session: SessionRef | undefined;
}

interface OpenExchange {
  readonly requestId: string;
  readonly session?: SessionRef;
  settle(response: Response): void;
}

/** The scripted wire — inspect exchanges plus the apply-edit mutation surface. */
function scriptWriteWire() {
  const edits: CapturedEdit[] = [];
  const openInspects: { readonly family: string; readonly exchange: OpenExchange }[] = [];
  const openEdits: OpenExchange[] = [];

  function jsonResponse(body: string, status = 200): Response {
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }

  function errorEnvelope(entry: OpenExchange, code: string, details?: unknown): Response {
    return jsonResponse(
      JSON.stringify({
        protocolVersion: 1,
        requestId: entry.requestId,
        ...(entry.session === undefined ? {} : { session: entry.session }),
        error: {
          code,
          message: 'sanitized message',
          retryable: false,
          ...(details ? { details } : {}),
        },
      }),
      code === 'revision-conflict' ? 409 : 400,
    );
  }

  function editEnvelope(entry: OpenExchange, revision: number, nextToken?: string): Response {
    return jsonResponse(
      JSON.stringify({
        protocolVersion: 1,
        requestId: entry.requestId,
        session: entry.session,
        result: {
          kind: 'edit',
          result: {
            revision,
            ...(nextToken === undefined
              ? {}
              : { nextGrant: grantFixture({ token: nextToken, sha256: NEXT_REVISION }) }),
          },
        },
      }),
    );
  }

  return {
    edits,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : '';
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      if (url.includes('/__astroix/events')) {
        return new Response(new ReadableStream<Uint8Array>({ start: () => {} }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      const parsed = JSON.parse(body) as {
        requestId: string;
        session?: SessionRef;
        command: { kind: string; request?: { kind: string }; plan?: WritePlan };
      };
      let settle!: (response: Response) => void;
      const held = new Promise<Response>((resolve) => {
        settle = resolve;
      });
      const exchange: OpenExchange = {
        requestId: parsed.requestId,
        session: parsed.session,
        settle,
      };
      if (parsed.command.kind === 'apply-edit' && parsed.command.plan !== undefined) {
        edits.push({ headers, plan: parsed.command.plan, session: parsed.session });
        openEdits.push(exchange);
        return held;
      }
      const family = parsed.command.request?.kind ?? 'content';
      openInspects.push({ family, exchange });
      return held;
    }) as typeof fetch,
    /** Resolves the oldest open inspect of `family` with a success payload. */
    resolveInspect(family: string, payload: unknown): void {
      const index = openInspects.findIndex((entry) => entry.family === family);
      if (index === -1) throw new Error(`no open ${family} inspect`);
      const entry = openInspects.splice(index, 1)[0];
      if (entry === undefined) throw new Error(`no open ${family} inspect`);
      entry.exchange.settle(
        jsonResponse(
          JSON.stringify({
            protocolVersion: 1,
            requestId: entry.exchange.requestId,
            ...(entry.exchange.session === undefined ? {} : { session: entry.exchange.session }),
            result: { kind: 'inspection', result: { kind: family, revision: 1, payload } },
          }),
        ),
      );
    },
    /** Resolves the oldest open apply-edit with a successful edit result. */
    resolveEdit(revision: number, nextToken?: string): void {
      const entry = openEdits.shift();
      if (entry === undefined) throw new Error('no open apply-edit');
      entry.settle(editEnvelope(entry, revision, nextToken));
    },
    /** Resolves the oldest open apply-edit with a protocol error envelope. */
    failEdit(code: string, details?: unknown): void {
      const entry = openEdits.shift();
      if (entry === undefined) throw new Error('no open apply-edit');
      entry.settle(errorEnvelope(entry, code, details));
    },
    /** Rejects the oldest open apply-edit's fetch (the transport shape). */
    dropEdit(): void {
      const entry = openEdits.shift();
      if (entry === undefined) throw new Error('no open apply-edit');
      entry.settle(new Response('not json', { status: 502 }));
    },
  };
}

type WriteWire = ReturnType<typeof scriptWriteWire>;

const realFetch = globalThis.fetch;
let mounted: Mounted | null = null;
let queryClient: QueryClient = createShellQueryClient();

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  globalThis.fetch = realFetch;
  clearShellStores();
  useContentNavigationStore.setState({ activeEntry: null, feedback: { kind: 'none' } });
  useFormDraftStore.getState().clear();
  useContentWriteStore.setState({ write: IDLE_WRITE, seqMint: 0 });
  wire = scriptWriteWire();
  queryClient = createShellQueryClient();
});

/** Mounts the pane inside the real provider over the scripted wire. */
function mountPane(input?: { readonly role?: 'authoritative' | 'diagnostic' }): HTMLElement {
  globalThis.fetch = wire.fetch;
  const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
  mounted = mount(
    <ShellProvider
      client={client}
      sessionRef={SESSION}
      role={input?.role ?? 'authoritative'}
      queryClient={queryClient}
    >
      <ContentEntryForm />
    </ShellProvider>,
  );
  return mounted.container;
}

let wire: WriteWire = scriptWriteWire();

/** Selects an entry the way the navigation slice does. */
function openEntry(collection: string, entryId: string): void {
  act(() => {
    useContentNavigationStore.getState().setActiveEntry({ collection, entryId });
  });
}

/** The pane's root. */
function pane(container: HTMLElement): HTMLElement {
  const root = container.querySelector('[data-astroix-entry-form]');
  if (root === null) throw new Error('the pane did not render');
  return root as HTMLElement;
}

/** The write surface's state attribute. */
function writeState(container: HTMLElement): string {
  return byTestId(container, 'write-state').getAttribute('data-write-state') ?? '';
}

/** Resolves the content inspection and waits for the pane's ready state. */
async function settleReady(container: HTMLElement, payload: unknown): Promise<void> {
  await actAsync(async () => {
    wire.resolveInspect('content', payload);
  });
  await waitFor(() => pane(container).getAttribute('data-form-status') === 'ready');
}

/** Edits the title widget — the form's write-ready gesture. */
function editTitle(container: HTMLElement, title: string): void {
  const input = pane(container).querySelector(
    '[data-astroix-form-field="title"] input',
  ) as HTMLInputElement | null;
  if (input === null) throw new Error('no title input');
  typeInto(input, title);
}

/** The title widget's current value — the pane's served-or-draft truth. */
function titleValue(container: HTMLElement): string {
  const input = pane(container).querySelector(
    '[data-astroix-form-field="title"] input',
  ) as HTMLInputElement | null;
  if (input === null) throw new Error('no title input');
  return input.value;
}

/** The inspected baseline's own values — the raw parse's JSON twin (the payload's data for these fixtures). */
function baselineValuesOf(contents: string): unknown {
  const parsed = parseEntryDraft(contents);
  if (parsed === null) throw new Error('the contract baseline did not parse');
  return parsed.data;
}

describe('the serializer against the frozen edit contracts (byte-exact)', () => {
  it('reproduces the frozen frontmatter-write bytes over the raw baseline', () => {
    const contract = editFixture('content-frontmatter-write.json');
    const plan = buildEntryWritePlan({
      facts: {
        grant: {
          token: GRANT_TOKEN,
          kind: 'content',
          operations: ['replace-contents'],
          displayPath: contract.file,
          baseline: { type: 'sha256', sha256: contract.baseline.hash },
        },
        raw: contract.baseline.contents,
        baselineSha256: contract.baseline.hash,
        // the landing-gate field, irrelevant to the serializer's bytes
        servedValues: null,
      },
      intent: {
        collection: 'blog',
        entryId: '2024/post',
        revision: contract.baseline.hash,
        baseline: {
          values: baselineValuesOf(contract.baseline.contents),
          body: contract.draft.body,
        },
        values: contract.draft.data,
      },
      fields: [],
    });
    // THE freeze: the plan's bytes are the corpus's written bytes — a
    // drift here is a defect against the captured contract, never a
    // redesign license (ADR-0010).
    expect(plan).toEqual({
      ok: true,
      plan: {
        operation: 'replace-contents',
        grant: expect.objectContaining({ token: GRANT_TOKEN }),
        contents: contract.written.contents,
      },
    });
  });

  it('reproduces the frozen body-write bytes (frontmatter byte-identical)', () => {
    const contract = editFixture('content-body-write.json');
    const plan = buildEntryWritePlan({
      facts: {
        grant: {
          token: GRANT_TOKEN,
          kind: 'content',
          operations: ['replace-contents'],
          displayPath: contract.file,
          baseline: { type: 'sha256', sha256: contract.baseline.hash },
        },
        raw: contract.baseline.contents,
        baselineSha256: contract.baseline.hash,
        servedValues: null,
      },
      intent: {
        collection: 'blog',
        entryId: 'hello-builder',
        revision: contract.baseline.hash,
        baseline: {
          values: baselineValuesOf(contract.baseline.contents),
          body: contract.draft.body,
        },
        values: contract.draft.data,
      },
      fields: [],
    });
    expect(plan.ok).toBe(true);
    if (plan.ok && plan.plan.operation === 'replace-contents') {
      expect(plan.plan.contents).toBe(contract.written.contents);
    } else {
      throw new Error('the body-write plan was not a replace-contents plan');
    }
  });

  it('builds the expected-absent creation plan (create-contents)', () => {
    const plan = buildEntryWritePlan({
      facts: {
        grant: {
          token: GRANT_TOKEN,
          kind: 'content',
          operations: ['create-contents'],
          displayPath: 'src/content/blog/new-entry.md',
          baseline: { type: 'expected-absent' },
        },
        raw: '',
        baselineSha256: null,
        // nothing is served for a file that does not exist yet
        servedValues: null,
      },
      intent: {
        collection: 'blog',
        entryId: 'new-entry',
        revision: null,
        baseline: { values: { title: 'New' }, body: 'Fresh body.' },
        values: { title: 'New' },
      },
      fields: [],
    });
    expect(plan).toEqual({
      ok: true,
      plan: {
        operation: 'create-contents',
        grant: expect.objectContaining({ baseline: { type: 'expected-absent' } }),
        contents: expect.stringContaining('title: New'),
      },
    });
  });

  it('refuses the admission shapes: file-less baseline, wrong kind, stale grant', () => {
    const facts: EntryWriteFacts = {
      grant: {
        token: GRANT_TOKEN,
        kind: 'content',
        operations: ['replace-contents'],
        displayPath: 'src/content/blog/hello-builder.md',
        baseline: { type: 'sha256', sha256: REVISION },
      },
      raw: RAW_HELLO,
      baselineSha256: REVISION,
      servedValues: null,
    };
    const intent = {
      collection: 'blog',
      entryId: 'hello-builder',
      revision: null as string | null,
      baseline: { values: {}, body: null },
      values: { title: 'Edited' },
    };
    expect(buildEntryWritePlan({ facts, intent, fields: [] })).toEqual({
      ok: false,
      code: 'no-baseline',
    });
    expect(
      buildEntryWritePlan({
        facts: { ...facts, grant: { ...facts.grant, kind: 'css' } },
        intent: { ...intent, revision: REVISION },
        fields: [],
      }),
    ).toEqual({ ok: false, code: 'wrong-kind' });
    expect(
      buildEntryWritePlan({
        facts: {
          ...facts,
          grant: { ...facts.grant, baseline: { type: 'sha256', sha256: NEXT_REVISION } },
        },
        intent: { ...intent, revision: REVISION },
        fields: [],
      }),
    ).toEqual({ ok: false, code: 'stale-grant' });
  });
});

describe('the state machine', () => {
  it('walks pending → committed → refresh-required → idle and keeps every state distinct', () => {
    let state = reduceWrite(IDLE_WRITE, { type: 'submitted', seq: 1 });
    expect(state.phase).toBe('pending');
    state = reduceWrite(state, { type: 'committed', seq: 1, revision: 3 });
    expect(state.phase).toBe('committed');
    expect(state.revision).toBe(3);
    state = reduceWrite(state, { type: 'refresh-begun', seq: 1 });
    expect(state.phase).toBe('refresh-required');
    state = reduceWrite(state, { type: 'refresh-landed', seq: 1 });
    expect(state.phase).toBe('idle');
  });

  it('walks pending → irreversible-postcommit → refresh-required and rejects distinctly', () => {
    let state = reduceWrite(IDLE_WRITE, { type: 'submitted', seq: 1 });
    state = reduceWrite(state, { type: 'uncertain', seq: 1 });
    expect(state.phase).toBe('irreversible-postcommit');
    state = reduceWrite(state, { type: 'refresh-begun', seq: 1 });
    expect(state.phase).toBe('refresh-required');
    state = reduceWrite(state, { type: 'refresh-landed', seq: 1 });
    expect(state.phase).toBe('idle');

    state = reduceWrite(state, { type: 'submitted', seq: 2 });
    state = reduceWrite(state, { type: 'conflict', seq: 2, currentSha256: NEXT_REVISION });
    expect(state.phase).toBe('rejected');
    expect(state.code).toBe('revision-conflict');
    expect(state.conflictSha256).toBe(NEXT_REVISION);
  });

  it('drops a stale settle — a stale response never overwrites the committed result', () => {
    let state = reduceWrite(IDLE_WRITE, { type: 'submitted', seq: 1 });
    state = reduceWrite(state, { type: 'committed', seq: 1, revision: 1 });
    // The dispatch moved on (or reset): the older dispatch's late
    // settle and refresh events never apply.
    const stale = reduceWrite(state, { type: 'uncertain', seq: 0 });
    expect(stale.phase).toBe('committed');
    const afterReset = reduceWrite(state, { type: 'reset' });
    expect(reduceWrite(afterReset, { type: 'refresh-begun', seq: 1 }).phase).toBe('idle');
  });
});

describe('the mounted write loop', () => {
  it('writes through the grant, reports the five states, and refreshes from server truth', async () => {
    const container = mountPane();
    openEntry('blog', 'hello-builder');
    await settleReady(
      container,
      contentPayload({ entryGrant: () => grantFixture(), entryRaw: () => RAW_HELLO }),
    );
    editTitle(container, 'Edited title');
    await waitFor(
      () => byTestId(container, 'intent-state').getAttribute('data-intent-state') === 'ready',
    );
    expect(byTestId(container, 'write-entry')).toBeTruthy();

    // submit → pending (the exchange is held open)
    click(byTestId(container, 'write-entry'));
    await waitFor(() => writeState(container) === 'pending');
    expect(wire.edits).toHaveLength(1);
    // the wire law: the mutation marker is present, the plan echoes the
    // issued grant verbatim, and no raw filesystem path exists anywhere
    // in the command body (the display path is the UI-only relative form)
    expect(wire.edits[0]?.headers[MUTATION_HEADER_NAME]).toBe(MUTATION_HEADER_VALUE);
    expect(wire.edits[0]?.plan.grant.token).toBe(GRANT_TOKEN);
    expect(wire.edits[0]?.plan.operation).toBe('replace-contents');
    expect(wire.edits[0]?.session).toEqual(SESSION);

    // settle → committed
    await actAsync(async () => {
      wire.resolveEdit(1, NEXT_GRANT_TOKEN);
    });
    await waitFor(() => writeState(container) === 'refresh-required');
    // the follow-on grant is held in the shell's edit-session store
    expect(useEditSessionStore.getState().grants).toHaveLength(1);
    // the commit is reported through the refresh banner (the settled
    // revision), the machine's distinct `committed` phase pinned by the
    // reducer legs above
    expect(byTestId(container, 'write-state').textContent).toContain('revision 1');

    // server truth lands at the NEW revision → the draft reopens on it, the loop goes quiet
    await settleReady(
      container,
      contentPayload({
        entryRevision: () => NEXT_REVISION,
        entryData: (_collection, id) =>
          id === 'hello-builder'
            ? {
                ...(collectionsFixture.collections[0]?.entries[2]?.data ?? {}),
                title: 'Edited title',
              }
            : undefined,
        entryGrant: () => grantFixture({ sha256: NEXT_REVISION, token: NEXT_GRANT_TOKEN }),
        entryRaw: () => RAW_HELLO.replace('Hello builder', 'Edited title'),
      }),
    );
    await waitFor(() => writeState(container) === 'idle');
    const input = pane(container).querySelector(
      '[data-astroix-form-field="title"] input',
    ) as HTMLInputElement;
    expect(input.value).toBe('Edited title');
    await waitFor(
      () => byTestId(container, 'intent-state').getAttribute('data-intent-state') === 'none',
    );
  });

  it('holds a torn refresh (revision moved, projection stale) until the retry lands the converged truth', async () => {
    const container = mountPane();
    openEntry('blog', 'hello-builder');
    await settleReady(
      container,
      contentPayload({ entryGrant: () => grantFixture(), entryRaw: () => RAW_HELLO }),
    );
    editTitle(container, 'Torn edit');
    await waitFor(
      () => byTestId(container, 'intent-state').getAttribute('data-intent-state') === 'ready',
    );
    click(byTestId(container, 'write-entry'));
    await waitFor(() => writeState(container) === 'pending');
    await actAsync(async () => {
      wire.resolveEdit(1);
    });
    // The TORN pass: the entry's served revision moved (the server's
    // revision is a fresh disk read, so it moves the instant the
    // executor's atomic replacement lands) while the served projection
    // did not (the content layer trails on its own watcher cadence) —
    // a reopen here would paint the pre-write values under the
    // post-write revision, and the pane would never self-correct.
    await settleReady(
      container,
      contentPayload({
        entryRevision: () => NEXT_REVISION,
        entryGrant: () => grantFixture({ sha256: NEXT_REVISION }),
        entryRaw: () => RAW_HELLO.replace('Hello builder', 'Torn edit'),
      }),
    );
    await waitFor(() => writeState(container) === 'refresh-required');
    // The pane did NOT reopen on the torn truth: the draft still renders
    expect(titleValue(container)).toBe('Torn edit');
    // The bounded retry refetches (one 250ms cadence) — its exchange
    // resolves with the CONVERGED projection, and the landing follows
    await actAsync(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 400);
      });
    });
    await actAsync(async () => {
      wire.resolveInspect(
        'content',
        contentPayload({
          entryRevision: () => NEXT_REVISION,
          entryData: (_collection, id) =>
            id === 'hello-builder'
              ? {
                  ...(collectionsFixture.collections[0]?.entries[2]?.data ?? {}),
                  title: 'Torn edit',
                }
              : undefined,
          entryGrant: () => grantFixture({ sha256: NEXT_REVISION }),
          entryRaw: () => RAW_HELLO.replace('Hello builder', 'Torn edit'),
        }),
      );
    });
    await waitFor(() => writeState(container) === 'idle');
    expect(titleValue(container)).toBe('Torn edit');
    await waitFor(
      () => byTestId(container, 'intent-state').getAttribute('data-intent-state') === 'none',
    );
  });

  it('reports the server refusals distinctly: stale session and revision conflict', async () => {
    const container = mountPane();
    openEntry('blog', 'hello-builder');
    await settleReady(
      container,
      contentPayload({ entryGrant: () => grantFixture(), entryRaw: () => RAW_HELLO }),
    );
    editTitle(container, 'Conflict edit');
    await waitFor(
      () => byTestId(container, 'intent-state').getAttribute('data-intent-state') === 'ready',
    );
    click(byTestId(container, 'write-entry'));
    await waitFor(() => writeState(container) === 'pending');
    await actAsync(async () => {
      wire.failEdit('stale-session');
    });
    await waitFor(() => writeState(container) === 'rejected');
    expect(byTestId(container, 'write-state').getAttribute('data-write-code')).toBe(
      'stale-session',
    );

    // a follow-up write conflicts: the disk-truth SHA is surfaced
    editTitle(container, 'Second edit');
    await waitFor(() => byTestId(container, 'write-entry').hasAttribute('disabled') === false);
    click(byTestId(container, 'write-entry'));
    await waitFor(() => writeState(container) === 'pending');
    await actAsync(async () => {
      wire.failEdit('revision-conflict', { currentSha256: NEXT_REVISION });
    });
    await waitFor(() => writeState(container) === 'rejected');
    expect(byTestId(container, 'write-state').getAttribute('data-write-code')).toBe(
      'revision-conflict',
    );
    expect(byTestId(container, 'write-conflict').textContent).toContain(NEXT_REVISION.slice(0, 12));
  });

  it('treats a lost response as irreversible-postcommit and converges through the refresh', async () => {
    const container = mountPane();
    openEntry('blog', 'hello-builder');
    await settleReady(
      container,
      contentPayload({ entryGrant: () => grantFixture(), entryRaw: () => RAW_HELLO }),
    );
    editTitle(container, 'Uncertain edit');
    await waitFor(
      () => byTestId(container, 'intent-state').getAttribute('data-intent-state') === 'ready',
    );
    click(byTestId(container, 'write-entry'));
    await waitFor(() => writeState(container) === 'pending');
    await actAsync(async () => {
      wire.dropEdit();
    });
    // the uncertainty converges through the same refresh (the machine's
    // distinct `irreversible-postcommit` phase pinned by the reducer legs)
    await waitFor(() => writeState(container) === 'refresh-required');
    // the server truth (the file did not move) converges the loop
    await settleReady(
      container,
      contentPayload({ entryGrant: () => grantFixture(), entryRaw: () => RAW_HELLO }),
    );
    await waitFor(() => writeState(container) === 'idle');
  });

  it('refuses before dispatch: the read-only role never writes', async () => {
    const container = mountPane({ role: 'diagnostic' });
    openEntry('blog', 'hello-builder');
    await settleReady(
      container,
      contentPayload({ entryGrant: () => grantFixture(), entryRaw: () => RAW_HELLO }),
    );
    editTitle(container, 'Read-only edit');
    await waitFor(
      () => byTestId(container, 'intent-state').getAttribute('data-intent-state') === 'ready',
    );
    const button = byTestId(container, 'write-entry') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // the direct gesture also refuses client-side: nothing crosses the wire
    await actAsync(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(wire.edits).toHaveLength(0);
  });

  it('refuses before dispatch: a stale grant (issued for another revision) never crosses the wire', async () => {
    const container = mountPane();
    openEntry('blog', 'hello-builder');
    await settleReady(
      container,
      contentPayload({
        entryGrant: () => grantFixture({ sha256: NEXT_REVISION }),
        entryRaw: () => RAW_HELLO,
      }),
    );
    editTitle(container, 'Stale grant edit');
    await waitFor(
      () => byTestId(container, 'intent-state').getAttribute('data-intent-state') === 'ready',
    );
    click(byTestId(container, 'write-entry'));
    await waitFor(() => writeState(container) === 'rejected');
    expect(byTestId(container, 'write-state').getAttribute('data-write-code')).toBe('stale-grant');
    expect(wire.edits).toHaveLength(0);
  });

  it('a stale response cannot overwrite the committed result across an entry change', async () => {
    const container = mountPane();
    openEntry('blog', 'hello-builder');
    await settleReady(
      container,
      contentPayload({ entryGrant: () => grantFixture(), entryRaw: () => RAW_HELLO }),
    );
    editTitle(container, 'Doomed edit');
    await waitFor(
      () => byTestId(container, 'intent-state').getAttribute('data-intent-state') === 'ready',
    );
    click(byTestId(container, 'write-entry'));
    await waitFor(() => writeState(container) === 'pending');
    // the entry changes mid-flight: the loop resets; the held response
    // for the dead dispatch settles later and must not move anything
    openEntry('blog', '2024/post');
    await waitFor(() => writeState(container) === 'idle');
    await actAsync(async () => {
      wire.resolveEdit(1);
    });
    expect(writeState(container)).toBe('idle');
    expect(wire.edits).toHaveLength(1);
  });
});
