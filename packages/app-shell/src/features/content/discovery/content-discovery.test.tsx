import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppClient } from '../../../app-client.ts';
import { ShellProvider } from '../../../app-shell/shell-provider.tsx';
import { byTestId, click, type Mounted, mount, waitFor } from '../../../app-shell/test-mount.tsx';
import { inspectionFixture } from '../../../presentation/fixtures.ts';
import { clearShellStores } from '../../../state/shell-stores.ts';
import { ContentDiscovery } from './content-discovery.tsx';
import {
  contentPayload,
  type DiscoveryWire,
  routesPayload,
  scriptDiscoveryWire,
} from './test-wire.ts';

/**
 * The discovery panel's focused lane (#251's AC): the structured
 * loading/empty/ready/unsupported/diagnostic states over the REAL
 * shell provider and the REAL AppClient against a scripted wire —
 * raw paths never render, entry clicks resolve through E5 alone, and
 * the unrouted click stays a legend, never a navigation.
 *
 * The ready legs run over the FROZEN corpora (the canonical fixture's
 * collections + routes payloads — the same truth the Playwright battery
 * drives live), so the panel is pinned against the contract shape, not
 * a re-implementation of it.
 */

const ORIGIN = 'http://project.localhost:4426';
const CAPABILITY = 'client-capability-fixture';
const SESSION: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 4 };

const collectionsFixture = inspectionFixture('collections.json');
const routesFixture = inspectionFixture('routes.json');

/**
 * The document's own origin — the project origin the navigation
 * resolves candidates against (G3's law: the shell document and the
 * canvas share it). happy-dom's is not the wire origin under test.
 */
const DOC_ORIGIN = globalThis.location.origin;

/** The frozen collections as the E4 payload carries them (plus the interior fields the projection drops). */
const frozenContentPayload = contentPayload({
  collections: collectionsFixture.collections.map((collection) => ({
    name: collection.name,
    entries: collection.entries.map((entry) => ({ id: entry.id, filePath: entry.filePath })),
  })),
});

const realFetch = globalThis.fetch;
let wire: DiscoveryWire = scriptDiscoveryWire();
let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  globalThis.fetch = realFetch;
  clearShellStores();
  wire = scriptDiscoveryWire();
});

/** Mounts the panel inside the real provider over the scripted wire. */
function mountPanel(): HTMLElement {
  globalThis.fetch = wire.fetch;
  const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
  mounted = mount(
    <ShellProvider client={client} sessionRef={SESSION}>
      <ContentDiscovery />
    </ShellProvider>,
  );
  return mounted.container;
}

/** The panel's root state attribute. */
function status(container: HTMLElement): string {
  return (
    container
      .querySelector('[data-astroix-content-discovery]')
      ?.getAttribute('data-discovery-status') ?? 'missing'
  );
}

describe('the discovery states', () => {
  it('renders the structured loading state while either inspection is in flight', () => {
    const container = mountPanel();
    expect(status(container)).toBe('loading');
    expect(byTestId(container, 'discovery-status').textContent).toContain('discovering');
  });

  it('renders the ready listing over the frozen corpora — collections, entries, unrouted markers', async () => {
    const container = mountPanel();
    wire.resolveInspect('content', frozenContentPayload);
    wire.resolveInspect('routes', routesPayload(routesFixture.routes));
    await waitFor(() => status(container) === 'ready');

    const collections = container.querySelectorAll('[data-astroix-collection]');
    expect([...collections].map((node) => node.getAttribute('data-astroix-collection'))).toEqual([
      'blog',
      'gallery',
      'homepage',
      'notes',
    ]);
    // the frozen resolution corpus's unrouted truth: showcase, index, scratch
    for (const entryId of ['showcase', 'index', 'scratch']) {
      expect(
        container
          .querySelector(`[data-astroix-entry="${entryId}"]`)
          ?.hasAttribute('data-astroix-entry-unrouted'),
        entryId,
      ).toBe(true);
    }
    expect(
      container
        .querySelector('[data-astroix-entry="2024/post"]')
        ?.hasAttribute('data-astroix-entry-unrouted'),
    ).toBe(false);
  });

  it('renders the empty state when the project declares no content at all', async () => {
    const container = mountPanel();
    wire.resolveInspect('content', contentPayload({ collections: [] }));
    wire.resolveInspect('routes', routesPayload([]));
    await waitFor(() => status(container) === 'empty');
    expect(byTestId(container, 'discovery-status').textContent).toContain('no content collections');
  });

  it('renders the unsupported state with the sanitized diagnostics when every collection failed a certified category', async () => {
    const container = mountPanel();
    wire.resolveInspect('content', {
      collections: [],
      diagnostics: [
        { code: 'unknown-loader', collection: 'recipes', expected: 'glob()', observed: 'object' },
      ],
      revision: 'c'.repeat(64),
    });
    wire.resolveInspect('routes', routesPayload([]));
    await waitFor(() => status(container) === 'unsupported');
    expect(byTestId(container, 'discovery-status').textContent).toContain('no supported');
    const row = container.querySelector('[data-astroix-unsupported-collection="recipes"]');
    expect(row?.textContent).toContain('unknown-loader');
    expect(row?.textContent).toContain('expected glob()');
    // the structural observed shape is sanitized by contract — no path rides it
    expect(row?.textContent).toContain('observed object');
  });

  it('surfaces the ready listing beside the unsupported-collections notice when some collections are certified', async () => {
    const container = mountPanel();
    wire.resolveInspect(
      'content',
      contentPayload({
        collections: [{ name: 'blog', entries: [{ id: 'hello-builder' }] }],
        diagnostics: [
          {
            code: 'unsupported-collection-shape',
            collection: 'legacy',
            expected: 'content layer',
            observed: 'legacy shape',
          },
        ],
      }),
    );
    wire.resolveInspect('routes', routesPayload(routesFixture.routes));
    await waitFor(() => status(container) === 'ready');
    expect(container.querySelector('[data-astroix-collection="blog"]')).not.toBeNull();
    expect(
      container.querySelector('[data-astroix-unsupported-collection="legacy"]')?.textContent,
    ).toContain('unsupported-collection-shape');
  });

  it('renders the diagnostic state for a refused exchange — the sanitized protocol reason only', async () => {
    const container = mountPanel();
    wire.resolveInspect('content', frozenContentPayload);
    wire.failInspect('routes', 'stale-session');
    await waitFor(() => status(container) === 'diagnostic');
    expect(byTestId(container, 'discovery-diagnostic').textContent).toBe(
      'inspection refused: stale-session',
    );
  });

  it('renders the diagnostic state for a drifted payload — fail closed, never a heuristic parse', async () => {
    const container = mountPanel();
    wire.resolveInspect('content', { collections: 'nope' });
    wire.resolveInspect('routes', routesPayload(routesFixture.routes));
    await waitFor(() => status(container) === 'diagnostic');
    expect(byTestId(container, 'discovery-diagnostic').textContent).toContain('drifted');
  });
});

describe('no raw paths in any state', () => {
  it('the ready panel renders no source path anywhere — ids and names only', async () => {
    const container = mountPanel();
    wire.resolveInspect('content', frozenContentPayload);
    wire.resolveInspect('routes', routesPayload(routesFixture.routes));
    await waitFor(() => status(container) === 'ready');
    expect(container.textContent).not.toContain('src/content');
    expect(container.textContent).not.toContain('.md');
  });
});

describe('entry clicks drive navigation through E5 alone', () => {
  /**
   * A REAL iframe element whose same-origin `contentWindow` is spied —
   * the product locator finds it by the canvas root's product
   * attribute, exactly as it finds the live canvas.
   */
  function installCanvasFrame(): { assigned: string[]; canvasRoot: HTMLElement } {
    const assigned: string[] = [];
    const frame = document.createElement('iframe');
    Object.defineProperty(frame, 'contentWindow', {
      value: {
        location: {
          assign: (url: string) => {
            assigned.push(url);
          },
        },
      },
    });
    const canvasRoot = document.createElement('div');
    canvasRoot.setAttribute('data-astroix-canvas', '');
    canvasRoot.append(frame);
    document.body.append(canvasRoot);
    return { assigned, canvasRoot };
  }

  /** Mounts the panel with a canvas frame present and both inspections resolved. */
  async function mountReadyWithCanvas(): Promise<{
    container: HTMLElement;
    assigned: string[];
    canvasRoot: HTMLElement;
  }> {
    const container = mountPanel();
    const { assigned, canvasRoot } = installCanvasFrame();
    wire.resolveInspect('content', frozenContentPayload);
    wire.resolveInspect('routes', routesPayload(routesFixture.routes));
    await waitFor(() => status(container) === 'ready');
    return { container, assigned, canvasRoot };
  }

  it('a routed entry click navigates the canvas to the natural URL E5 resolves', async () => {
    const { container, assigned, canvasRoot } = await mountReadyWithCanvas();
    try {
      click(container.querySelector('[data-astroix-entry="2024/post"]') as HTMLElement);
      // the frozen route-resolution contract's own candidate: /blog/2024/post
      expect(assigned).toEqual([`${DOC_ORIGIN}/blog/2024/post`]);
      await waitFor(() =>
        (byTestId(container, 'navigation-feedback').textContent ?? '').includes('navigated to'),
      );
      expect(byTestId(container, 'navigation-feedback').textContent).toContain('/blog/2024/post');
      // the row highlights — the open entry is selection state
      expect(
        container.querySelector('[data-astroix-entry="2024/post"]')?.getAttribute('data-active'),
      ).toBe('true');
    } finally {
      canvasRoot.remove();
    }
  });

  it('the flat blog id takes the segment-param spelling — the plurality rule over E5', async () => {
    const { container, assigned, canvasRoot } = await mountReadyWithCanvas();
    try {
      click(container.querySelector('[data-astroix-entry="hello-builder"]') as HTMLElement);
      expect(assigned).toEqual([`${DOC_ORIGIN}/blog/hello-builder`]);
    } finally {
      canvasRoot.remove();
    }
  });

  it('an unrouted entry click navigates nothing and reports the legend', async () => {
    const { container, assigned, canvasRoot } = await mountReadyWithCanvas();
    try {
      click(container.querySelector('[data-astroix-entry="scratch"]') as HTMLElement);
      expect(assigned).toEqual([]);
      await waitFor(
        () => (byTestId(container, 'navigation-feedback').textContent ?? '').length > 0,
      );
      expect(byTestId(container, 'navigation-feedback').textContent).toBe(
        'no route renders scratch',
      );
    } finally {
      canvasRoot.remove();
    }
  });

  it('reports the canvas-unavailable diagnostic when no canvas is mounted', async () => {
    const container = mountPanel();
    wire.resolveInspect('content', frozenContentPayload);
    wire.resolveInspect('routes', routesPayload(routesFixture.routes));
    await waitFor(() => status(container) === 'ready');
    click(container.querySelector('[data-astroix-entry="2024/post"]') as HTMLElement);
    await waitFor(() => (byTestId(container, 'navigation-feedback').textContent ?? '').length > 0);
    expect(byTestId(container, 'navigation-feedback').textContent).toBe(
      'the canvas is not available',
    );
  });
});
