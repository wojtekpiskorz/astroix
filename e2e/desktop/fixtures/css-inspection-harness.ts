import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { app, BrowserWindow } from 'electron';
import { WINDOW_SECURITY_PREFERENCES } from '../../../apps/desktop/src/main/security-policy.ts';

/**
 * The CSS inspection Electron harness main (#249, I1; a TEST main,
 * never the product composition — ADR-0008's lane-gate law, the
 * document-authority harness's idiom): one REAL hardened Electron
 * window over the SHARED control-plane composition running in a REAL
 * stock-Node child (the forked plane entry — the same composition the
 * web host boots, the same one the desktop child boots; never
 * Electron-as-Node, so the plane's worker and dev-server children are
 * real-Node too). Everything the renderer does is the product flow: the
 * launcher's own Activate button drives the real transition, the
 * project document is the real client build with the CSS vertical's
 * panel, the canvas is the real same-origin iframe on the real project
 * origin, and the selection is the real click capture.
 *
 * Protocol: one JSON config on argv[2]; one `astroix-css-harness: <json>`
 * line per report on stdout; one JSON command per stdin line:
 * `activate` (drive the launcher's own button, await the settled
 * project document), `select {selector}` (dispatch a click in the
 * canvas document), `panel` (read the CSS panel's structured truth),
 * `quit`.
 */

interface HarnessConfig {
  readonly planeEntry: string;
  readonly repoRoot: string;
  readonly registryDirectory: string;
  readonly clientDist: string;
  readonly registerRoot: string;
  readonly port: number;
  readonly registerModule: string;
  readonly nodeExecutable: string;
}

function readConfig(argv: readonly string[]): HarnessConfig {
  const parsed: unknown = JSON.parse(argv[2] ?? '{}');
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('astroix-css-harness: the config argument is not a JSON object');
  }
  const config = parsed as Record<string, unknown>;
  for (const field of [
    'planeEntry',
    'repoRoot',
    'registryDirectory',
    'clientDist',
    'registerRoot',
    'registerModule',
    'nodeExecutable',
  ]) {
    if (typeof config[field] !== 'string' || (config[field] as string).length === 0) {
      throw new Error(`astroix-css-harness: the config argument misses ${field}`);
    }
  }
  if (typeof config.port !== 'number' || !Number.isInteger(config.port)) {
    throw new Error('astroix-css-harness: the config argument misses its port');
  }
  return {
    planeEntry: config.planeEntry as string,
    repoRoot: config.repoRoot as string,
    registryDirectory: config.registryDirectory as string,
    clientDist: config.clientDist as string,
    registerRoot: config.registerRoot as string,
    port: config.port as number,
    registerModule: config.registerModule as string,
    nodeExecutable: config.nodeExecutable as string,
  };
}

function report(event: Record<string, unknown>): void {
  console.log(`astroix-css-harness: ${JSON.stringify(event)}`);
}

/** One command off the spec's stdin. */
type HarnessCommand =
  | { readonly op: 'activate' }
  | { readonly op: 'select'; readonly selector: string }
  | { readonly op: 'panel' }
  | { readonly op: 'quit' };

/** One bounded step-wise wait over an executeJavaScript probe. */
async function pollWebContents(
  webContents: Electron.WebContents,
  probe: string,
  isDone: (value: unknown) => boolean,
  what: string,
  timeoutMs: number,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      last = await webContents.executeJavaScript(probe, true);
    } catch (error) {
      last = { error: String(error) };
    }
    if (isDone(last)) return last;
    if (Date.now() >= deadline) throw new Error(`harness: timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function main(): Promise<void> {
  const config = readConfig(process.argv);
  report({ kind: 'boot', stage: 'config-read' });
  await app.whenReady();
  report({ kind: 'boot', stage: 'app-ready' });

  // — the composition child: real stock Node, the shared composition —
  // Its stdout is piped (and re-emitted) so the harness can AWAIT the
  // listening line before any window loads: the plane boots the real
  // composition, which takes real time. Plain spawn (never fork —
  // Electron's fork demands an IPC channel this child does not need)
  // under the declared stock-Node executable, and FROM SOURCE — the
  // web host's own boot shape (`--experimental-transform-types
  // --import <the raw-node register>`), never a bundle: the
  // composition's worker spawn resolves the worker entry through
  // `import.meta.url`, which only resolves inside the real source tree
  // (the packaged desktop child uses H2's rebased tree for the same
  // law; a vite bundle would break the resolution).
  const plane: ChildProcess = spawn(
    config.nodeExecutable,
    [
      '--experimental-transform-types',
      '--import',
      config.registerModule,
      config.planeEntry,
      JSON.stringify({
        registryDirectory: config.registryDirectory,
        clientDist: config.clientDist,
        registerRoot: config.registerRoot,
        port: config.port,
        registerModule: config.registerModule,
      }),
    ],
    { cwd: config.repoRoot, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const planeListening = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('harness: the composition child never reported its listener')),
      60_000,
    );
    let buffer = '';
    plane.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      process.stdout.write(text);
      buffer += text;
      if (buffer.includes('css-plane: listening on')) {
        clearTimeout(timer);
        resolve();
      }
      buffer = buffer.slice(-512);
    });
    plane.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('harness: the composition child exited before listening'));
    });
  });
  const stopPlane = (): void => {
    plane.kill('SIGTERM');
  };
  app.on('quit', stopPlane);
  await planeListening;
  report({ kind: 'boot', stage: 'plane-listening' });

  // — the hardened window: the product's frozen security preferences —
  const win = new BrowserWindow({
    title: 'Astroix CSS inspection harness',
    width: 1440,
    height: 900,
    show: true,
    webPreferences: { ...WINDOW_SECURITY_PREFERENCES },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const origin = `http://launcher.localhost:${config.port}`;
  await win.webContents.loadURL(`${origin}/__astroix/app/`);

  // The launcher is live once its own session surface renders.
  await pollWebContents(
    win.webContents,
    `(() => ({ label: document.querySelector('[data-testid="session-label"]')?.textContent ?? null }))()`,
    (value) => {
      const label = (value as { label?: string | null } | null)?.label;
      return label === 'idle';
    },
    'the launcher document',
    60_000,
  );
  report({ kind: 'ready', url: win.webContents.getURL() });

  const handle = async (command: HarnessCommand): Promise<void> => {
    switch (command.op) {
      case 'activate': {
        // The product flow: the launcher's OWN Activate button, clicked
        // through the real document — the real transition runs, the
        // top level lands on the project origin, and the canvas settles
        // (the young dev server's post-connect self-reload included).
        // The button itself is polled into existence: the launcher's
        // project list loads asynchronously beside the idle label.
        const clicked = await pollWebContents(
          win.webContents,
          `(() => { const button = document.querySelector('[data-testid="project-list"] li [data-testid="activate"]'); if (button === null) return 'missing'; button.click(); return 'clicked'; })()`,
          (value) => value === 'clicked',
          "the launcher's Activate button",
          60_000,
        );
        const activated = await pollWebContents(
          win.webContents,
          `(() => ({ url: location.href, state: document.querySelector('[data-testid="canvas-origin-state"]')?.textContent ?? null }))()`,
          (value) => {
            const probe = value as { url?: string; state?: string } | null;
            return (
              typeof probe?.url === 'string' &&
              !probe.url.includes('launcher.') &&
              probe.state === 'project'
            );
          },
          'the activated project document',
          120_000,
        ).catch(async (error: unknown) => {
          // The failure report carries the launcher's own truth — the
          // honest diagnosis surface, never a bare timeout.
          const probe = await win.webContents.executeJavaScript(
            `(() => ({ url: location.href, label: document.querySelector('[data-testid="session-label"]')?.textContent ?? null, error: document.querySelector('[data-testid="command-error"]')?.textContent ?? null, failure: document.querySelector('[data-testid="last-failure"]')?.textContent ?? null, list: document.querySelector('[data-testid="project-list"]')?.children.length ?? -1, body: document.body.textContent?.slice(0, 300) ?? '' }))()`,
            true,
          );
          return {
            timedOut: error instanceof Error ? error.message : String(error),
            probe,
          };
        });
        report({ kind: 'activated', document: activated, click: clicked });
        return;
      }
      case 'select': {
        // The real click capture: a bubbling click on the canvas
        // document's element, exactly the event shape the shell's
        // capture listener consumes.
        const selector = JSON.stringify(command.selector);
        const selected = await pollWebContents(
          win.webContents,
          `(() => {
            const frame = document.querySelector('iframe[data-testid="canvas-frame"]');
            const doc = frame && frame.contentDocument;
            const element = doc && doc.querySelector(${selector});
            if (element === null || element === undefined) return { tag: null, want: null };
            element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            const tag = document.querySelector('[data-testid="selection-tag"]')?.textContent ?? null;
            return { tag, want: element.tagName.toLowerCase() };
          })()`,
          (value) => {
            const probe = value as { tag?: string | null; want?: string | null } | null;
            // Success is the panel reflecting the CLICKED element's own
            // tag — the click's state update is async, so the panel may
            // still show the previous selection ('none' or a prior tag)
            // right after the dispatch; the poll re-clicks until the
            // observed tag is the wanted one, covering the canvas's own
            // reload race too.
            return (
              typeof probe?.want === 'string' &&
              typeof probe.tag === 'string' &&
              probe.tag === probe.want
            );
          },
          `the canvas selection of ${command.selector}`,
          60_000,
        );
        report({ kind: 'selected', selection: selected });
        return;
      }
      case 'panel': {
        // The panel's structured truth — state, rows, the disclosure
        // sweep's text, and the read-only sweep's control count — read
        // straight from the live DOM. The settle-poll inside the panel
        // handles the young dev server; this poll only waits it out.
        const panel = await pollWebContents(
          win.webContents,
          `(() => {
            const panel = document.querySelector('[data-testid="css-panel"]');
            if (panel === null) return { state: 'no-panel' };
            const stateEl = panel.querySelector('[data-testid="css-rules-state"]');
            const rows = [...panel.querySelectorAll('[data-testid="css-rule"]')].map((row) => ({
              selector: row.getAttribute('data-css-selector'),
              effective: row.getAttribute('data-css-effective'),
              media: row.getAttribute('data-css-media'),
              file: row.getAttribute('data-css-file'),
              line: row.getAttribute('data-css-line'),
              winner: row.getAttribute('data-css-winner') === 'true',
            }));
            const state = stateEl !== null
              ? stateEl.getAttribute('data-state')
              : panel.querySelector('[data-testid="css-rule-list"]') !== null
                ? 'ready'
                : panel.querySelector('[data-testid="css-rules-diagnostic"]') !== null
                  ? 'diagnostic'
                  : 'unknown';
            return {
              state,
              rows,
              text: panel.textContent ?? '',
              editable: panel.querySelectorAll('input, textarea, select, [contenteditable="true"]').length,
            };
          })()`,
          (value) => {
            const state = (value as { state?: string } | null)?.state;
            return state !== undefined && state !== 'loading';
          },
          'the CSS panel settling',
          150_000,
        );
        report({ kind: 'panel', panel });
        return;
      }
      case 'quit': {
        stopPlane();
        app.quit();
        return;
      }
    }
  };

  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const text = line.trim();
    if (text.length === 0) return;
    let command: HarnessCommand;
    try {
      command = JSON.parse(text) as HarnessCommand;
    } catch {
      report({ kind: 'unparseable-command' });
      return;
    }
    void handle(command).catch((error: unknown) => {
      report({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    });
  });
}

// The Electron-main invocation law every desktop main follows (never
// top-level await — an ESM entry with TLA deadlocks Electron's ready
// wiring): fire main, surface a failure as the harness's own report.
void main().catch((error: unknown) => {
  report({
    kind: 'harness-failed',
    message: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
  });
  app.exit(1);
});
