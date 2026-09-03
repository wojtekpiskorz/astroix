import { afterEach, describe, expect, it } from 'vitest';
import { createAppClient } from '../app-client.ts';
import { useAppStore } from '../state/app-store.ts';
import { useEditSessionStore } from '../state/edit-session-store.ts';
import { clearShellStores, shellStoreSnapshot } from '../state/shell-stores.ts';
import { aSelection } from '../state/test-fixtures.ts';
import { AppShell } from './app-shell.tsx';
import { ShellProvider } from './shell-provider.tsx';
import { CAPABILITY, type FetchScript, ORIGIN, scriptFetch } from './shell-test-harness.ts';
import { actAsync, byTestId, click, type Mounted, mount, waitFor } from './test-mount.tsx';

/**
 * The mounted provider lane (#241): the generation-scoped discipline
 * LIVE — the session query under its `['astroix', runtimeEpoch,
 * generation, …]` key, the one ordered reset at transition commit
 * (marker-written clearing BEFORE navigation), and the repeated
 * generation change with DELAYED fetch and SSE delivery: old-pair
 * responses and frames arriving late never repopulate the fresh
 * generation's state.
 */

const G1 = { runtimeEpoch: 'epoch-fixture', generation: 1 };

const LAUNCHER_URL = 'http://launcher.localhost:4426/__astroix/app/';
const G2 = { runtimeEpoch: 'epoch-fixture', generation: 2 };

const realFetch = globalThis.fetch;
let script: FetchScript = scriptFetch();
let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  globalThis.fetch = realFetch;
  clearShellStores();
  script = scriptFetch(); // a fresh wire per leg — no unresolved exchanges leak across mounts
});

interface MountedShell {
  readonly container: HTMLElement;
  readonly navigations: string[];
  /**
   * The marker text captured AT each navigation — the ordering proof.
   * The E2E legs intercept the navigation request and read the marker in
   * the still-alive old document; this is the unit tier's same
   * interception. Reading the marker after the flush instead would race
   * a later re-render: with navigation inert (a pushed array, not a
   * replaced document), a timer-scheduled re-render of the inspection
   * observer can rebuild the removed query — in a real host the aborted
   * session signal kills that fetch and the navigation disposes the
   * document, so the navigation-time truth is the contract's truth.
   */
  readonly markerAtNavigation: readonly string[];
}

function mountSession(
  ref: typeof G1,
  role: 'authoritative' | 'diagnostic' = 'authoritative',
): MountedShell {
  globalThis.fetch = script.fetch;
  const navigations: string[] = [];
  const markerAtNavigation: string[] = [];
  const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
  mounted = mount(
    <ShellProvider
      client={client}
      sessionRef={ref}
      role={role}
      launcherUrl={LAUNCHER_URL}
      navigate={(url) => {
        navigations.push(url);
        markerAtNavigation.push(
          document.querySelector('[data-testid="shell-state"]')?.textContent ?? '',
        );
      }}
    >
      <AppShell />
    </ShellProvider>,
  );
  return { container: mounted.container, navigations, markerAtNavigation };
}

describe('the generation-scoped session query', () => {
  it('caches the inspection under the exact triple key — and only it', async () => {
    const shell = mountSession(G1);
    script.resolveInspect(11);
    await waitFor(() => byTestId(shell.container, 'inspect-revision').textContent === '11');
    expect(byTestId(shell.container, 'shell-state').textContent).toContain('queries=1');
    expect(byTestId(shell.container, 'shell-state').textContent).toContain('reset=none');
  });
});

describe('the stream state converges on transport open (#342)', () => {
  it("reaches open with ZERO events delivered — an admitted idle stream is live, not 'connecting'", async () => {
    const shell = mountSession(G1);
    script.resolveInspect(11);
    await waitFor(() => byTestId(shell.container, 'inspect-revision').textContent === '11');
    // No frame is ever delivered: the transport-open signal alone
    // converges the state — the exact production shape of a quiet
    // session (nothing happened since activation, so the server has
    // nothing to send; the connection itself is the live truth).
    await waitFor(() => byTestId(shell.container, 'stream-state').textContent === 'open');
    // And nothing else moved: the wire carried no invalidation, so the
    // one inspect is still the only exchange.
    expect(script.inspectCount).toBe(1);
  });
});

describe('the commit-time reset', () => {
  it('clears every session surface BEFORE the navigation — the marker proves the order', async () => {
    const shell = mountSession(G1);
    script.resolveInspect(11);
    await waitFor(() => byTestId(shell.container, 'inspect-revision').textContent === '11');
    // Populate the shell stores the way the lanes will (gated writes under the bound pair).
    useAppStore.getState().setSelection(G1, aSelection());
    useEditSessionStore.getState().holdGrant(G1, { token: 'grant' });
    await waitFor(() =>
      (byTestId(shell.container, 'shell-state').textContent ?? '').includes('selection=1'),
    );
    expect(byTestId(shell.container, 'shell-state').textContent).toContain('grants=1');

    // The transition settles, then the ordered reset runs, then navigation.
    click(byTestId(shell.container, 'deactivate'));
    await waitFor(() => shell.navigations.length === 1);

    // The ordering proof: AT the navigation — after every clearing step,
    // before the top-level replacement — the marker already reports the
    // cleared state. This is the unit tier's mirror of the E2E
    // interception (read the still-alive old document's marker at the
    // navigation); it cannot race the post-reset re-renders that the
    // inert test navigation permits.
    const marker = shell.markerAtNavigation[0] ?? '';
    expect(marker).toContain('queries=0');
    expect(marker).toContain('selection=0');
    expect(marker).toContain('grants=0');
    expect(marker).toContain('reset=abort-fetches,close-sse,remove-queries,clear-stores');
    expect(shellStoreSnapshot().pendingMutations).toBe(0);
    // Navigation happened — exactly once, to the launcher, and AFTER the clears (marker already written).
    expect(shell.navigations).toEqual([LAUNCHER_URL]);
  });

  it('does not deactivate from a diagnostic target — the control never mounts', () => {
    const shell = mountSession(G1, 'diagnostic');
    expect(shell.container.querySelector('[data-testid="deactivate"]')).toBeNull();
  });
});

describe('the repeated generation change with delayed fetch and SSE delivery', () => {
  it('drops old-generation responses and frames after the switch — nothing repopulates', async () => {
    // Generation 1's document: query lands, stream opens under its pair.
    const first = mountSession(G1);
    script.resolveInspect(11);
    await waitFor(() => byTestId(first.container, 'inspect-revision').textContent === '11');
    script.deliverFrame(G1, { type: 'diagnostic', level: 'info', message: 'g1 frame' });
    await waitFor(() => byTestId(first.container, 'stream-state').textContent === 'open');

    // A stale frame (generation 2's pair) on generation 1's stream is dropped:
    // the display stays at its last honest state ('open' from the current frame).
    script.deliverFrame(G2, { type: 'diagnostic', level: 'info', message: 'foreign frame' });
    await waitFor(() => byTestId(first.container, 'stream-state').textContent === 'open');

    // The transition commits: the reset closes the belt and navigates.
    click(byTestId(first.container, 'deactivate'));
    await waitFor(() => first.navigations.length === 1);

    // ...and the fresh document mounts at generation 2 (a new client, new wire, new stores).
    mounted?.unmount();
    clearShellStores();
    script = scriptFetch();
    globalThis.fetch = script.fetch;
    const second = mountSession(G2);
    expect(byTestId(second.container, 'session-generation').textContent).toBe('2');
    expect(byTestId(second.container, 'shell-state').textContent).toContain('reset=none');

    // The DELAYED generation-1 response finally answers its dead exchange: it
    // belongs to the old document's closed belt — the new document's
    // inspection is a fresh exchange under the new triple.
    script.resolveInspect(12);
    await waitFor(() => byTestId(second.container, 'inspect-revision').textContent === '12');
    const marker = byTestId(second.container, 'shell-state').textContent ?? '';
    expect(marker).toContain('queries=1');
    expect(marker).toContain('selection=0');

    // Late old-pair writes against the fresh generation's stores are dropped.
    useAppStore.getState().setSelection(G1, aSelection());
    useEditSessionStore.getState().holdGrant(G1, { token: 'stale-grant' });
    // A late old-pair SSE frame on the fresh stream is dropped too — a
    // dispatched invalidation would have refetched (a second inspect).
    script.deliverFrame(G1, { type: 'invalidation', families: ['project'], revision: 2 });
    // A bounded settle: the dropped frame's misbehavior (a refetch, a grant
    // landing) would surface inside this window — and does not.
    await actAsync(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const after = byTestId(second.container, 'shell-state').textContent ?? '';
    expect(after).toContain('selection=0');
    expect(after).toContain('grants=0');
    expect(script.inspectCount).toBe(1); // the dropped frame refetched nothing

    // The fresh pair's own frame still dispatches.
    script.deliverFrame(G2, { type: 'diagnostic', level: 'info', message: 'g2 frame' });
    await waitFor(() => byTestId(second.container, 'stream-state').textContent === 'open');
  });
});
