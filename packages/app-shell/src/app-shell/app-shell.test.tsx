import { afterEach, describe, expect, it } from 'vitest';
import { createAppClient } from '../app-client.ts';
import { clearShellStores } from '../state/shell-stores.ts';
import { AppShell } from './app-shell.tsx';
import { ShellProvider } from './shell-provider.tsx';
import { CAPABILITY, ORIGIN, scriptFetch } from './shell-test-harness.ts';
import { byTestId, click, type Mounted, mount, waitFor } from './test-mount.tsx';

/**
 * The shell frame's focused lane (#241's ACs): the stable feature slots
 * (named, typed, placeholder-honest — neither vertical implemented),
 * the role-exposed controls (the diagnostic target gets no lifecycle
 * control at all), and the retained #240 surfaces living on the rebuilt
 * shell.
 */

const SESSION = { runtimeEpoch: 'epoch-fixture', generation: 4 };

const realFetch = globalThis.fetch;
let script = scriptFetch();
let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  globalThis.fetch = realFetch;
  clearShellStores();
  script = scriptFetch(); // a fresh wire per leg — no unresolved exchanges leak across mounts
});

function mountShell(role: 'authoritative' | 'diagnostic'): Mounted {
  globalThis.fetch = script.fetch;
  const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
  mounted = mount(
    <ShellProvider client={client} sessionRef={SESSION} role={role}>
      <AppShell />
    </ShellProvider>,
  );
  return mounted;
}

describe('the feature slots', () => {
  it('renders the three workbench slots with honest placeholders', () => {
    const { container } = mountShell('authoritative');
    for (const slot of ['sidebar', 'editor-dock', 'canvas']) {
      expect(
        container.querySelector(`[data-slot="${slot}"]`),
        `missing slot: ${slot}`,
      ).not.toBeNull();
      expect(container.querySelector(`[data-slot="${slot}"]`)?.textContent).toContain(
        `slot: ${slot}`,
      );
    }
  });

  it('renders provided slot content in place of the placeholders — the verticals land here', () => {
    globalThis.fetch = script.fetch;
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    mounted = mount(
      <ShellProvider client={client} sessionRef={SESSION}>
        <AppShell
          slots={{
            sidebar: <p data-testid="css-vertical-panel" />,
            editorDock: <p data-testid="content-vertical-pane" />,
            canvas: <p data-testid="canvas-frame" />,
          }}
        />
      </ShellProvider>,
    );
    const { container } = mounted;
    expect(container.querySelector('[data-testid="css-vertical-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="content-vertical-pane"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="canvas-frame"]')).not.toBeNull();
    expect(container.textContent).not.toContain('slot: sidebar');
  });
});

describe('the role-exposed controls', () => {
  it('exposes the deactivation control to the authoritative editing client', () => {
    const { container } = mountShell('authoritative');
    expect(container.querySelector('[data-testid="deactivate"]')).not.toBeNull();
    expect(container.querySelector('[data-astroix-role-badge="authoritative"]')).not.toBeNull();
  });

  it('exposes NO lifecycle control to a diagnostic target — inspection only', () => {
    const { container } = mountShell('diagnostic');
    expect(container.querySelector('[data-testid="deactivate"]')).toBeNull();
    expect(container.querySelector('[data-astroix-role-badge="diagnostic"]')).not.toBeNull();
    // The read paths stay: the inspection probe renders for diagnostics too.
    expect(container.querySelector('[data-testid="reinspect"]')).not.toBeNull();
  });
});

describe('the retained session surfaces', () => {
  it('shows the bound generation and the inspection revision under the session query', async () => {
    const { container } = mountShell('authoritative');
    expect(byTestId(container, 'session-generation').textContent).toBe('4');
    script.resolveInspect(7);
    await waitFor(() => byTestId(container, 'inspect-revision').textContent === '7');
  });

  it('reports a failed command through the single command-error surface', async () => {
    const { container } = mountShell('authoritative');
    script.resolveInspect(7);
    await waitFor(() => byTestId(container, 'inspect-revision').textContent === '7');
    click(byTestId(container, 'reinspect'));
    script.failInspect('unauthorized');
    await waitFor(() => byTestId(container, 'command-error').hidden === false);
    expect(byTestId(container, 'command-error').textContent).toBe('unauthorized');
  });
});
