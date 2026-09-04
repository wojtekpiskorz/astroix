import type { SessionRef, WritePlan } from '@wojciechpiskorz/astroix-protocol';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { spliceText } from '../../../../core/src/splice-writer.ts';
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
import { useAppStore } from '../../state/app-store.ts';
import { selectionDescriptorOf } from '../../state/selection.ts';
import { clearShellStores } from '../../state/shell-stores.ts';
import { CssSidebar } from './css-sidebar.tsx';
import { useCssWriteStore } from './editing/write-store.ts';
import { useCssInspectionStore } from './store.ts';
import { useCssUndoStore } from './undo.ts';

/**
 * The CSS auto-write loop's focused matrix (#250's mutation legs): the
 * REAL sidebar over the REAL provider and AppClient against a scripted
 * wire — styles inspections AND apply-edit mutations over real
 * protocol envelope bodies — with the canvas staged exactly as the
 * panel's own tests stage it. The happy path is pinned against the
 * FROZEN edit corpus's world (the corpus records, the fixture
 * baselines as the served raw, the frozen splice bytes as the plan the
 * wire must carry), and the matrix covers the AC's refusals and
 * states: the grant-bound wire law, the renewal, the stable conflict,
 * the grant death, the honest uncertainty, the debounce coalescing,
 * and the undo inverse.
 */

const ORIGIN = 'http://project.localhost:4426';
const CAPABILITY = 'client-capability-fixture';
const SESSION: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 4 };

const corpus = inspectionFixture('css-index.attribute.json');
const cssSplice = editFixture('css-splice.json');
const cssScoped = editFixture('css-scoped-splice.json');

const GRANT_TOKEN = 'b'.repeat(48);
const NEXT_GRANT_TOKEN = 'c'.repeat(48);

/** One wire-shaped css grant — the issued claim, echoed verbatim. */
function cssGrant(token: string, sha256: string): unknown {
  return {
    token,
    kind: 'css',
    operations: ['replace-contents', 'splice'],
    displayPath: 'src/pages/home.css',
    baseline: { type: 'sha256', sha256 },
  };
}

/** One served payload shape: the corpus records plus the write facts over the fixture baselines. */
function servedPayload(input?: {
  readonly revision?: number;
  readonly homeRaw?: string;
  readonly grantToken?: string;
  readonly records?: typeof corpus.records;
}): { payload: unknown; homeRaw: string; revision: number } {
  const homeRaw = input?.homeRaw ?? cssSplice.baseline.contents;
  const revision = input?.revision ?? 3;
  return {
    payload: {
      revision,
      invalidationRevision: 2,
      records: input?.records ?? corpus.records,
      writeFacts: [
        {
          file: 'src/pages/home.css',
          grant: cssGrant(input?.grantToken ?? GRANT_TOKEN, sha256of(homeRaw)),
          raw: homeRaw,
        },
        {
          file: 'src/pages/index.astro',
          grant: {
            token: 'd'.repeat(48),
            kind: 'css',
            operations: ['replace-contents', 'splice'],
            displayPath: 'src/pages/index.astro',
            baseline: { type: 'sha256', sha256: cssScoped.baseline.hash },
          },
          raw: cssScoped.baseline.contents,
        },
      ],
    },
    homeRaw,
    revision,
  };
}

/** sha256 hex — deterministic per contents (the test's own mint, F-region per contents). */
function sha256of(contents: string): string {
  // the served facts' baseline binds the served raw: any stable
  // per-contents hex stands in for the server's digest here — the
  // loop never interprets it, the wire carries it verbatim
  let hash = 0x811c9dc5;
  for (let index = 0; index < contents.length; index += 1) {
    hash ^= contents.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').repeat(8);
}

/** One captured apply-edit exchange. */
interface CapturedEdit {
  readonly plan: WritePlan;
  readonly session: SessionRef | undefined;
}

interface OpenExchange {
  readonly requestId: string;
  readonly session?: SessionRef;
  readonly styles: boolean;
  settle(response: Response): void;
}

/** The scripted wire — held styles inspections plus held apply-edits. */
function scriptWriteWire() {
  const edits: CapturedEdit[] = [];
  const open: OpenExchange[] = [];

  function jsonResponse(body: string, status = 200): Response {
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }

  return {
    edits,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : '';
      if (url.includes('/__astroix/events')) {
        return new Response(new ReadableStream<Uint8Array>({ start: () => {} }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      const parsed = JSON.parse(body) as {
        requestId: string;
        session?: SessionRef;
        command: { kind?: string; request?: { kind?: string }; plan?: WritePlan };
      };
      let settle!: (response: Response) => void;
      const held = new Promise<Response>((resolve) => {
        settle = resolve;
      });
      const exchange: OpenExchange = {
        requestId: parsed.requestId,
        session: parsed.session,
        styles: parsed.command.kind === 'inspect',
        settle,
      };
      open.push(exchange);
      if (parsed.command.kind === 'apply-edit' && parsed.command.plan !== undefined) {
        edits.push({ plan: parsed.command.plan, session: parsed.session });
      }
      return held;
    }) as typeof fetch,
    /** Resolves the OLDEST open styles inspect with a success payload. */
    resolveStyles(payload: unknown, revision = 3): void {
      const index = open.findIndex((entry) => entry.styles);
      const entry = index === -1 ? undefined : open.splice(index, 1)[0];
      if (entry === undefined) throw new Error('no open styles inspect');
      entry.settle(
        jsonResponse(
          JSON.stringify({
            protocolVersion: 1,
            requestId: entry.requestId,
            ...(entry.session === undefined ? {} : { session: entry.session }),
            result: { kind: 'inspection', result: { kind: 'styles', revision, payload } },
          }),
        ),
      );
    },
    /** Resolves the oldest open apply-edit with a successful edit result carrying a follow-on grant. */
    resolveEdit(revision: number): void {
      const entry = open.shift();
      if (entry === undefined) throw new Error('no open apply-edit');
      entry.settle(
        jsonResponse(
          JSON.stringify({
            protocolVersion: 1,
            requestId: entry.requestId,
            ...(entry.session === undefined ? {} : { session: entry.session }),
            result: {
              kind: 'edit',
              result: {
                revision,
                nextGrant: cssGrant(NEXT_GRANT_TOKEN, 'f'.repeat(64)),
              },
            },
          }),
        ),
      );
    },
    /** Resolves the oldest open apply-edit with a protocol error envelope. */
    failEdit(code: string, details?: unknown): void {
      const entry = open.shift();
      if (entry === undefined) throw new Error('no open apply-edit');
      entry.settle(
        jsonResponse(
          JSON.stringify({
            protocolVersion: 1,
            requestId: entry.requestId,
            ...(entry.session === undefined ? {} : { session: entry.session }),
            error: {
              code,
              message: 'sanitized message',
              retryable: false,
              ...(details === undefined ? {} : { details }),
            },
          }),
          code === 'revision-conflict' ? 409 : 400,
        ),
      );
    },
    /** The count of unresolved exchanges (waits that still hold). */
    openCount(): number {
      return open.length;
    },
  };
}

type WriteWire = ReturnType<typeof scriptWriteWire>;

const realFetch = globalThis.fetch;
let mounted: Mounted | null = null;
let canvasHost: HTMLElement | null = null;
let wire: WriteWire = scriptWriteWire();

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  globalThis.fetch = realFetch;
  clearShellStores();
  useCssInspectionStore.setState({ served: null, openRowKey: null });
  useCssUndoStore.getState().clear();
  useCssWriteStore.setState({
    write: { phase: 'idle', seq: 0, revision: null, code: null, conflictSha256: null },
  });
  wire = scriptWriteWire();
  canvasHost?.remove();
  canvasHost = null;
});

/** Stages the canvas document the panel's own tests stage. */
function stageCanvas(): HTMLIFrameElement {
  const host = document.createElement('div');
  host.setAttribute('data-astroix-canvas', '');
  const frame = document.createElement('iframe');
  host.appendChild(frame);
  document.body.appendChild(host);
  canvasHost = host;
  const doc = frame.contentDocument;
  if (doc === null) throw new Error('the test canvas frame has no document');
  doc.body.innerHTML =
    '<section class="hero"><h1 class="hero-title" data-astro-cid-lcdefpme>Astroix fixture</h1>' +
    '<p class="hero-lead">lead</p></section>';
  return frame;
}

/** Mounts the sidebar over the scripted wire with the selection landed. */
function mountPanel(): HTMLElement {
  globalThis.fetch = wire.fetch;
  const frame = stageCanvas();
  const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
  useAppStore.getState().bindSession(SESSION);
  useAppStore.getState().setCanvasState(SESSION, { url: `${ORIGIN}/`, origin: 'project' });
  const element = frame.contentDocument?.querySelector('.hero-title');
  if (element === undefined || element === null) throw new Error('the canvas staged no element');
  useAppStore.getState().setSelection(SESSION, selectionDescriptorOf(element));
  mounted = mount(
    <ShellProvider client={client} sessionRef={SESSION}>
      <CssSidebar />
    </ShellProvider>,
  );
  return mounted.container;
}

/** Lands the panel at the ready rows over the served payload. */
async function landReady(container: HTMLElement, served: { payload: unknown }): Promise<void> {
  await waitFor(() => wire.openCount() > 0 || panelReady(container));
  if (wire.openCount() > 0) wire.resolveStyles(served.payload);
  await waitFor(() => panelReady(container));
}

/** The panel's ready truth — the rule list rendered. */
function panelReady(container: HTMLElement): boolean {
  return container.querySelector('[data-testid="css-rule-list"]') !== null;
}

/** The write status badge's state word. */
function writeState(container: HTMLElement): string {
  return byTestId(container, 'css-write-status').getAttribute('data-write-state') ?? '';
}

/** One declaration's value input, by property. */
function declInput(container: HTMLElement, property: string): HTMLInputElement {
  const input = container.querySelector(
    `[data-testid="css-decl-input"][data-css-prop="${property}"]`,
  );
  if (input === null) throw new Error(`no declaration input for ${property}`);
  return input as HTMLInputElement;
}

/** Opens the editor on the home.css `.hero-title` row (the corpus's first global occurrence). */
async function openEditor(container: HTMLElement): Promise<void> {
  const editButtons = container.querySelectorAll('[data-testid="css-rule-edit"]');
  // rows: the scoped winner (index.astro) then the three globals — the
  // FIRST global is the fixture's edited rule
  const button = editButtons[1];
  if (button === undefined) throw new Error('no edit affordance on the global row');
  click(button);
  await waitFor(() => container.querySelector('[data-testid="css-rule-editor"]') !== null);
}

describe('the CSS auto-write loop — the frozen world', () => {
  it('auto-writes the frozen splice bytes through the grant, renews, and undoes the inverse', async () => {
    const container = mountPanel();
    const served = servedPayload();
    await landReady(container, served);
    await openEditor(container);

    // the declaration input carries the served value
    const input = declInput(container, 'font-size');
    expect(input.value).toBe('3rem');

    // the edit schedules the pause — the badge says so before any wire traffic
    typeInto(input, '3.5rem');
    expect(writeState(container)).toBe('scheduled');

    // the settled pause fires exactly one apply-edit with the frozen bytes
    await waitFor(() => wire.edits.length === 1);
    const edit = wire.edits[0];
    if (edit === undefined) throw new Error('no edit captured');
    expect(edit.plan.operation).toBe('splice');
    if (edit.plan.operation !== 'splice') return;
    // BYTE-EXACT against the frozen contract
    expect(edit.plan.range).toEqual(cssSplice.edit.range);
    expect(edit.plan.replacement).toBe(cssSplice.edit.replacement);
    // the wire law: the echoed opaque grant, and no ABSOLUTE path
    // anywhere (the display path is the sanctioned project-relative
    // UI-only form the grant schema itself carries)
    expect(edit.plan.grant.token).toBe(GRANT_TOKEN);
    expect(edit.plan.grant.kind).toBe('css');
    expect(JSON.stringify(edit.plan)).not.toMatch(/\/(Users|home|private)\//);
    expect(JSON.stringify(edit.plan)).not.toMatch(/file:\/\//);

    // the committed settle + the follow-on grant — editing may continue
    await actAsync(async () => {
      wire.resolveEdit(1);
    });
    // the refresh: the loop invalidates the styles key — answer with the
    // post-write truth (raw moved, revision moved, fresh grant)
    const nextRaw = spliceText(cssSplice.baseline.contents, {
      start: cssSplice.edit.range.start,
      end: cssSplice.edit.range.end,
      replacement: cssSplice.edit.replacement,
    });
    const delta = nextRaw.length - cssSplice.baseline.contents.length;
    const nextRecords = corpus.records.map((record) => ({
      ...record,
      range:
        record.file === 'src/pages/home.css' && record.range.start > cssSplice.edit.range.start
          ? { start: record.range.start + delta, end: record.range.end + delta }
          : record.range,
    }));
    const nextServed = servedPayload({
      revision: 4,
      homeRaw: nextRaw,
      grantToken: 'e'.repeat(48),
      records: nextRecords,
    });
    await waitFor(() => wire.openCount() > 0);
    await actAsync(async () => {
      wire.resolveStyles(nextServed.payload, 4);
    });
    await waitFor(() => writeState(container) === 'quiet');

    // the undo is armed; its dispatch carries the inverse splice bytes
    const undoButton = byTestId(container, 'css-undo') as HTMLButtonElement;
    expect(undoButton.disabled).toBe(false);
    click(undoButton);
    await waitFor(() => wire.edits.length === 2);
    const undoEdit = wire.edits[1];
    if (undoEdit === undefined) throw new Error('no undo edit captured');
    expect(undoEdit.plan.operation).toBe('splice');
    if (undoEdit.plan.operation !== 'splice') return;
    expect(undoEdit.plan.range).toEqual({
      start: cssSplice.edit.range.start,
      end: cssSplice.edit.range.start + cssSplice.edit.replacement.length,
    });
    expect(undoEdit.plan.replacement).toBe(cssSplice.edit.replaced);
    // the undo's grant is the freshest served one — the renewed chain
    expect(undoEdit.plan.grant.token).toBe('e'.repeat(48));
  });

  it('coalesces the pause — two quick edits dispatch ONE write with the final value', async () => {
    const container = mountPanel();
    const served = servedPayload();
    await landReady(container, served);
    await openEditor(container);
    const input = declInput(container, 'font-size');
    typeInto(input, '3.5');
    typeInto(input, '3.5rem');
    await waitFor(() => wire.edits.length === 1);
    expect(writeState(container)).toMatch(/writing|quiet/);
    // no second dispatch ever crosses — the pause replaced, not stacked
    await actAsync(async () => {
      wire.resolveEdit(1);
    });
    expect(wire.edits.length).toBe(1);
  });

  it('a revision conflict writes nothing more: the stable conflict state, the reload, undo cleared', async () => {
    const container = mountPanel();
    const served = servedPayload();
    await landReady(container, served);
    await openEditor(container);
    // seed one undo entry to prove the conflict clears it (inside act —
    // the editor's subscription must flush the store update)
    act(() => {
      useCssUndoStore.getState().bind(SESSION);
      useCssUndoStore.getState().push(SESSION, {
        key: 'seed',
        file: 'src/pages/home.css',
        range: { start: 0, end: 1 },
        replacement: 'x',
        replaced: 'y',
      });
    });
    expect(byTestId(container, 'css-undo').hasAttribute('disabled')).toBe(false);

    const input = declInput(container, 'font-size');
    typeInto(input, '3.5rem');
    await waitFor(() => wire.edits.length === 1);
    await actAsync(async () => {
      wire.failEdit('revision-conflict', { currentSha256: 'a'.repeat(64) });
    });
    // the stable conflict state with the disk-truth handback
    await waitFor(() => writeState(container) === 'conflict');
    expect(byTestId(container, 'css-write-status').getAttribute('data-write-conflict')).toBe(
      'a'.repeat(64),
    );
    // the reload: the loop invalidates the styles key — resolve it; the
    // conflict state STAYS until the next edit re-arms
    await waitFor(() => wire.openCount() > 0);
    await actAsync(async () => {
      wire.resolveStyles(servedPayload({ revision: 4 }).payload, 4);
    });
    expect(writeState(container)).toBe('conflict');
    // the undo stack died with the conflict reload
    expect(byTestId(container, 'css-undo').hasAttribute('disabled')).toBe(true);
    expect(wire.edits.length).toBe(1);
  });

  it('a grant death refuses without writing and reloads the served facts', async () => {
    const container = mountPanel();
    const served = servedPayload();
    await landReady(container, served);
    await openEditor(container);
    const input = declInput(container, 'font-size');
    typeInto(input, '3.5rem');
    await waitFor(() => wire.edits.length === 1);
    await actAsync(async () => {
      wire.failEdit('grant-rejected');
    });
    await waitFor(() => writeState(container) === 'rejected');
    expect(byTestId(container, 'css-write-status').getAttribute('data-write-code')).toBe(
      'grant-rejected',
    );
    // the reload opened a fresh inspection — the recovery vehicle
    await waitFor(() => wire.openCount() > 0);
    expect(wire.edits.length).toBe(1);
  });

  it('an unconfirmable outcome is the honest uncertainty, converged by the refresh', async () => {
    const container = mountPanel();
    const served = servedPayload();
    await landReady(container, served);
    await openEditor(container);
    const input = declInput(container, 'font-size');
    typeInto(input, '3.5rem');
    await waitFor(() => wire.edits.length === 1);
    await actAsync(async () => {
      wire.failEdit('internal-error');
    });
    // the uncertainty surfaces, then the refresh converges it to quiet
    await waitFor(() => wire.openCount() > 0);
    const nextRaw = spliceText(cssSplice.baseline.contents, {
      start: cssSplice.edit.range.start,
      end: cssSplice.edit.range.end,
      replacement: cssSplice.edit.replacement,
    });
    await actAsync(async () => {
      wire.resolveStyles(servedPayload({ revision: 4, homeRaw: nextRaw }).payload, 4);
    });
    await waitFor(() => writeState(container) === 'quiet');
  });

  it('the scoped selector rename dispatches the frozen scoped-splice species', async () => {
    const container = mountPanel();
    const served = servedPayload();
    await landReady(container, served);
    // open the editor on the SCOPED winner row (index.astro)
    const editButtons = container.querySelectorAll('[data-testid="css-rule-edit"]');
    const button = editButtons[0];
    if (button === undefined) throw new Error('no scoped edit affordance');
    click(button);
    await waitFor(() => container.querySelector('[data-testid="css-rule-editor"]') !== null);
    const selectorInput = byTestId(container, 'css-selector-input') as HTMLInputElement;
    expect(selectorInput.value).toBe('.hero-title');
    typeInto(selectorInput, '.hero-headline');
    await waitFor(() => wire.edits.length === 1);
    const edit = wire.edits[0];
    if (edit === undefined) throw new Error('no edit captured');
    expect(edit.plan.operation).toBe('splice');
    if (edit.plan.operation !== 'splice') return;
    expect(edit.plan.range).toEqual(cssScoped.edit.range);
    expect(edit.plan.replacement).toBe(cssScoped.edit.replacement);
    expect(edit.plan.grant.displayPath).toBe('src/pages/index.astro');
  });
});
