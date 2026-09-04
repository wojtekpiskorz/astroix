import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppClient } from '../../app-client.ts';
import { ShellProvider } from '../../app-shell/shell-provider.tsx';
import { byTestId, click, type Mounted, mount, waitFor } from '../../app-shell/test-mount.tsx';
import { inspectionFixture } from '../../presentation/fixtures.ts';
import { useAppStore } from '../../state/app-store.ts';
import { selectionDescriptorOf } from '../../state/selection.ts';
import { clearShellStores } from '../../state/shell-stores.ts';
import { CssSidebar } from './css-sidebar.tsx';
import { useCssInspectionStore } from './store.ts';
import { type CssWire, scriptCssWire } from './test-wire.ts';

/**
 * The CSS panel's focused lane (#249's AC, the J1 mount idiom): the
 * structured states over the REAL shell provider and the REAL AppClient
 * against a scripted wire, with a LIVE canvas frame beside the panel —
 * the disclosed re-match seam runs against a real same-origin iframe
 * document exactly as in the shell. The ready legs run over the FROZEN
 * attribute-strategy corpus (the shapes the live host serves), and the
 * read-only law is pinned at the DOM: no edit control exists anywhere
 * in the panel, and no raw path or module-graph shape ever renders.
 */

const ORIGIN = 'http://project.localhost:4426';
const CAPABILITY = 'client-capability-fixture';
const SESSION: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 4 };

const corpus = inspectionFixture('css-index.attribute.json');

const realFetch = globalThis.fetch;
let wire: CssWire = scriptCssWire();
let mounted: Mounted | null = null;
let canvasFrame: HTMLIFrameElement | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  globalThis.fetch = realFetch;
  clearShellStores();
  useCssInspectionStore.setState({ served: null, openRowKey: null });
  wire = scriptCssWire();
  canvasFrame?.remove();
  canvasFrame = null;
});

/** Creates the live canvas frame with the fixture's hero markup, as G3's canvas would host it. */
function stageCanvasDocument(): void {
  canvasFrame = document.createElement('iframe');
  canvasFrame.setAttribute('data-testid', 'canvas-frame');
  document.body.appendChild(canvasFrame);
  const doc = canvasFrame.contentDocument;
  if (doc === null) throw new Error('the test canvas frame has no document');
  doc.body.innerHTML =
    '<section class="hero"><h1 class="hero-title" data-astro-cid-lcdefpme>Astroix fixture</h1>' +
    '<p class="hero-lead">lead</p></section>';
}

/** The panel's state word (the StatePanel rows) or the ready/diagnostic surfaces' presence. */
function panelState(container: HTMLElement): string {
  const state = container.querySelector('[data-testid="css-rules-state"]');
  if (state !== null) return state.getAttribute('data-state') ?? 'missing';
  if (container.querySelector('[data-testid="css-rules-diagnostic"]') !== null) {
    return 'diagnostic';
  }
  return container.querySelector('[data-testid="css-rule-list"]') !== null ? 'ready' : 'missing';
}

/** Mounts the panel inside the real provider over the scripted wire, with the canvas staged and the selection landed. */
function mountPanel(options: { readonly withSelection?: boolean } = {}): HTMLElement {
  globalThis.fetch = wire.fetch;
  stageCanvasDocument();
  const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
  useAppStore.getState().bindSession(SESSION);
  useAppStore.getState().setCanvasState(SESSION, {
    url: `${ORIGIN}/`,
    origin: 'project',
  });
  if (options.withSelection !== false) {
    const element = canvasFrame?.contentDocument?.querySelector('.hero-title');
    if (element === undefined || element === null) throw new Error('the canvas staged no element');
    useAppStore.getState().setSelection(SESSION, selectionDescriptorOf(element));
  }
  mounted = mount(
    <ShellProvider client={client} sessionRef={SESSION}>
      <CssSidebar />
    </ShellProvider>,
  );
  return mounted.container;
}

/** The corpus's records as one converged wire payload. */
function corpusPayload(revision = 3): unknown {
  return { revision, invalidationRevision: 2, records: corpus.records };
}

describe('the CSS panel states', () => {
  it('renders the no-selection state first — no query exists while nothing is selected', () => {
    const container = mountPanel({ withSelection: false });
    expect(panelState(container)).toBe('no-selection');
    expect(wire.openCount()).toBe(0);
  });

  it('renders the no-route state when the canvas is not on the project origin', () => {
    globalThis.fetch = wire.fetch;
    stageCanvasDocument();
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    useAppStore.getState().bindSession(SESSION);
    useAppStore.getState().setCanvasState(SESSION, { url: null, origin: 'external' });
    const element = canvasFrame?.contentDocument?.querySelector('.hero-title');
    useAppStore.getState().setSelection(SESSION, selectionDescriptorOf(element as Element));
    mounted = mount(
      <ShellProvider client={client} sessionRef={SESSION}>
        <CssSidebar />
      </ShellProvider>,
    );
    expect(panelState(mounted.container)).toBe('no-route');
    expect(wire.openCount()).toBe(0);
  });

  it('issues the settled request shape over the wire — {kind: styles, route: the observed pathname} under the session pair', async () => {
    const container = mountPanel();
    expect(panelState(container)).toBe('loading');
    wire.resolveStyles(corpusPayload());
    await waitFor(() => panelState(container) === 'ready');
    const selections = wire.stylesSelections();
    expect(selections).toHaveLength(1);
    expect(selections[0]).toEqual({ kind: 'styles', route: '/' });
    const body = JSON.parse(wire.captured[0]?.body ?? '{}') as {
      session?: { runtimeEpoch: string; generation: number };
    };
    expect(body.session).toEqual(SESSION);
  });

  it('renders the frozen attribute corpus joined — winner, media, sanitized locations, deterministic order', async () => {
    const container = mountPanel();
    wire.resolveStyles(corpusPayload());
    await waitFor(() => panelState(container) === 'ready');
    const rows = container.querySelectorAll('[data-testid="css-rule"]');
    expect(rows).toHaveLength(4);
    const first = rows[0] as HTMLElement;
    expect(first.getAttribute('data-css-winner')).toBe('true');
    expect(first.getAttribute('data-css-selector')).toBe('.hero-title');
    expect(first.getAttribute('data-css-effective')).toBe('.hero-title[data-astro-cid-lcdefpme]');
    expect(first.getAttribute('data-css-file')).toBe('src/pages/index.astro');
    expect(first.getAttribute('data-css-line')).toBe('24');
    // the three global occurrences keep payload order — two plain, one media-conditioned
    const globals = [...rows].slice(1).map((row) => row.getAttribute('data-css-media'));
    expect(globals).toEqual(['', '', '(max-width: 640px)']);
    // exactly one winner
    expect(container.querySelectorAll('[data-css-winner="true"]')).toHaveLength(1);
    // the disclosure sweep: nothing the module graph or the filesystem owns ever renders
    const text = container.textContent ?? '';
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain('/Users/');
    expect(text).not.toContain('routeComponent');
    expect(text).not.toContain('virtual:astro');
  });

  it('is read-only: no edit control exists anywhere in the panel', async () => {
    const container = mountPanel();
    wire.resolveStyles(corpusPayload());
    await waitFor(() => panelState(container) === 'ready');
    const panel = container.querySelector('[data-testid="css-panel"]');
    expect(panel).not.toBeNull();
    expect(
      panel?.querySelectorAll('input, textarea, select, [contenteditable="true"]'),
    ).toHaveLength(0);
    // the only controls are the row detail disclosures
    const buttons = panel?.querySelectorAll('button').length ?? 0;
    const toggles = panel?.querySelectorAll('[data-testid="css-rule-detail-toggle"]').length ?? 0;
    expect(buttons).toBe(toggles);
  });

  it('discloses the read-only rule detail and closes it again', async () => {
    const container = mountPanel();
    wire.resolveStyles(corpusPayload());
    await waitFor(() => panelState(container) === 'ready');
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="css-rule-detail-toggle"]',
    );
    if (toggle === null) throw new Error('no detail toggle rendered');
    click(toggle);
    const detail = container.querySelector('[data-testid="css-rule-detail"]');
    expect(detail?.textContent).toContain('scoped style block 0');
    expect(detail?.textContent).toContain('source range:');
    click(toggle);
    expect(container.querySelector('[data-testid="css-rule-detail"]')).toBeNull();
  });

  it('renders the empty state for an element nothing styles', async () => {
    globalThis.fetch = wire.fetch;
    stageCanvasDocument();
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    useAppStore.getState().bindSession(SESSION);
    useAppStore.getState().setCanvasState(SESSION, { url: `${ORIGIN}/`, origin: 'project' });
    const element = canvasFrame?.contentDocument?.querySelector('.hero');
    useAppStore.getState().setSelection(SESSION, selectionDescriptorOf(element as Element));
    mounted = mount(
      <ShellProvider client={client} sessionRef={SESSION}>
        <CssSidebar />
      </ShellProvider>,
    );
    // .hero has one global rule in the corpus — swap to an unstyled element
    const unstyled = canvasFrame?.contentDocument?.createElement('nav');
    (unstyled as Element).setAttribute('class', 'nothing');
    canvasFrame?.contentDocument?.body.appendChild(unstyled as Element);
    useAppStore.getState().setSelection(SESSION, selectionDescriptorOf(unstyled as Element));
    wire.resolveStyles(corpusPayload());
    const container = mounted?.container;
    if (container === undefined) throw new Error('the panel did not mount');
    await waitFor(() => panelState(container) === 'empty');
    expect(byTestId(container, 'css-rules-state').textContent).toContain('no matching rules');
  });

  it('clears the rows on the missing element — a DOM change that drops the selection is the honest empty truth', async () => {
    const container = mountPanel();
    wire.resolveStyles(corpusPayload());
    await waitFor(() => panelState(container) === 'ready');
    canvasFrame?.contentDocument?.querySelector('.hero-title')?.remove();
    await waitFor(() => panelState(container) === 'missing-element');
    expect(byTestId(container, 'css-rules-state').textContent).toContain('no longer in the canvas');
  });

  it('re-derives when the selection moves — the second element shows its own rows', async () => {
    const container = mountPanel();
    wire.resolveStyles(corpusPayload());
    await waitFor(() => panelState(container) === 'ready');
    const lead = canvasFrame?.contentDocument?.querySelector('.hero-lead');
    useAppStore.getState().setSelection(SESSION, selectionDescriptorOf(lead as Element));
    await waitFor(() => {
      const rows = container.querySelectorAll('[data-testid="css-rule"]');
      return rows.length === 1;
    });
    const row = container.querySelector('[data-testid="css-rule"]');
    expect(row?.getAttribute('data-css-selector')).toBe('.hero-lead');
    expect(row?.getAttribute('data-css-effective')).toBe('');
  });

  it('surfaces the unresolved route as its own state — the route-shaped 404, never a generic failure', async () => {
    const container = mountPanel();
    wire.failStyles('resource-not-found');
    await waitFor(() => panelState(container) === 'unresolved-route');
    expect(byTestId(container, 'css-rules-state').textContent).toContain('resolves to no route');
  });

  it('surfaces the sanitized diagnostic for a terminal refusal', async () => {
    const container = mountPanel();
    wire.failStyles('stale-session');
    await waitFor(() => panelState(container) === 'diagnostic');
    expect(byTestId(container, 'css-rules-diagnostic').textContent).toContain(
      'inspection refused: stale-session',
    );
  });

  it('falls back to no-selection when the reset clears the shell stores — no stale session state survives', async () => {
    const container = mountPanel();
    wire.resolveStyles(corpusPayload());
    await waitFor(() => panelState(container) === 'ready');
    clearShellStores();
    await waitFor(() => panelState(container) === 'no-selection');
  });
});
