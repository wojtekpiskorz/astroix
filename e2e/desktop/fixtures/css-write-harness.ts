import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { app, BrowserWindow } from 'electron';
import { WINDOW_SECURITY_PREFERENCES } from '../../../apps/desktop/src/main/security-policy.ts';

/**
 * The CSS auto-write Electron harness main (#250, I2; a TEST main,
 * never the product composition — ADR-0008's lane-gate law, the CSS
 * inspection harness's idiom): one REAL hardened Electron window over
 * the SHARED control-plane composition running in a REAL stock-Node
 * child, driving the REAL product flow — the launcher's own Activate
 * button, the real client build with the CSS vertical's editing
 * surface, the real canvas, the real click capture — plus this lane's
 * own gestures: opening the rule editor, typing a declaration value
 * through the real input (the native setter + input event, exactly
 * the browser's own change), and observing the write badge and the
 * canvas document's own stylesheet tags (HMR's arrival face) straight
 * from the live documents.
 *
 * Protocol: one JSON config on argv[2]; one `astroix-css-harness: <json>`
 * line per report on stdout; one JSON command per stdin line:
 * `activate`, `select {selector}`, `edit {row, prop, value}`,
 * `status`, `canvas-hmr {needle}`, `quit`.
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
  | { readonly op: 'edit'; readonly row: number; readonly prop: string; readonly value: string }
  | { readonly op: 'status' }
  | { readonly op: 'canvas-hmr'; readonly needle: string }
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
  // The TEST harness's own timing world (not a product choice): the
  // lane observes live CSS in a window the OS may consider occluded,
  // and Chromium's occlusion suspension would freeze both the
  // auto-write debounce timers and the canvas's style recalc — the
  // very flows under test. A real user edits with the window visible;
  // these switches restore that world for the lane.
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  report({ kind: 'boot', stage: 'config-read' });
  await app.whenReady();
  report({ kind: 'boot', stage: 'app-ready' });

  // — the composition child: real stock Node, the shared composition —
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
    title: 'Astroix CSS auto-write harness',
    width: 1440,
    height: 900,
    show: true,
    webPreferences: { ...WINDOW_SECURITY_PREFERENCES },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const origin = `http://launcher.localhost:${config.port}`;
  await win.webContents.loadURL(`${origin}/__astroix/app/`);

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
        );
        report({ kind: 'activated', document: activated, click: clicked });
        return;
      }
      case 'select': {
        const selector = JSON.stringify(command.selector);
        const selected = await pollWebContents(
          win.webContents,
          `(() => {
            const frame = document.querySelector('[data-astroix-canvas] iframe');
            const doc = frame && frame.contentDocument;
            const element = doc && doc.querySelector(${selector});
            if (element === null || element === undefined) return { tag: null, want: null };
            element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            const tag = document.querySelector('[data-testid="selection-tag"]')?.textContent ?? null;
            return { tag, want: element.tagName.toLowerCase() };
          })()`,
          (value) => {
            const probe = value as { tag?: string | null; want?: string | null } | null;
            return (
              typeof probe?.want === 'string' &&
              typeof probe?.tag === 'string' &&
              probe.tag === probe.want
            );
          },
          `the canvas selection of ${command.selector}`,
          60_000,
        );
        report({ kind: 'selected', selection: selected });
        return;
      }
      case 'edit': {
        // the REAL edit gesture: open the row's editor, type the value
        // through the input's native setter + input event — exactly the
        // change event shape the browser's own typing produces
        const row = command.row;
        const prop = JSON.stringify(command.prop);
        const value = JSON.stringify(command.value);
        const edited = await pollWebContents(
          win.webContents,
          `(() => {
            const buttons = [...document.querySelectorAll('[data-testid="css-rule-edit"]')];
            const button = buttons[${row}];
            if (button === undefined) return { done: false, why: 'no-row' };
            if (document.querySelector('[data-testid="css-rule-editor"]') === null) button.click();
            const input = document.querySelector(
              '[data-testid="css-decl-input"][data-css-prop=' + ${prop} + ']',
            );
            if (input === null) return { done: false, why: 'no-input' };
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter === undefined) return { done: false, why: 'no-setter' };
            setter.call(input, ${value});
            input.dispatchEvent(new Event('input', { bubbles: true }));
            const badge = document.querySelector('[data-testid="css-write-status"]');
            return { done: true, value: input.value, state: badge?.getAttribute('data-write-state') ?? null };
          })()`,
          (result) => {
            const probe = result as { done?: boolean; value?: string } | null;
            return probe?.done === true && probe.value === command.value;
          },
          `the declaration edit of ${command.prop}`,
          60_000,
        );
        report({ kind: 'edited', edit: edited });
        return;
      }
      case 'status': {
        const status = await pollWebContents(
          win.webContents,
          `(() => ({
            state: document.querySelector('[data-testid="css-write-status"]')?.getAttribute('data-write-state') ?? null,
            conflict: document.querySelector('[data-testid="css-write-status"]')?.getAttribute('data-write-conflict') ?? null,
            undoDisabled: (() => {
              const button = document.querySelector('[data-testid="css-undo"]');
              if (button === null) return null;
              return 'disabled' in button ? Boolean(button.disabled) : null;
            })(),
            decls: [...document.querySelectorAll('[data-testid="css-decl-input"]')].map(
              (input) => ({
                prop: input.getAttribute('data-css-prop'),
                value: input.value,
              }),
            ),
          }))()`,
          (value) => (value as { state?: string | null } | null)?.state != null,
          'the write badge',
          150_000,
        );
        report({ kind: 'status', status });
        return;
      }
      case 'canvas-hmr': {
        // the canvas document's OWN stylesheet — vite's hot update
        // arrival face: the served style carries the written bytes, and
        // the marker set in the document's window SURVIVES (a hot
        // update, never a reload — Chromium skips style recalc for
        // occluded harness windows, so the computed cascade is the
        // web battery's face of this same law, not this lane's)
        const needle = JSON.stringify(command.needle);
        const hmr = await pollWebContents(
          win.webContents,
          `(() => {
            const frame = document.querySelector('[data-astroix-canvas] iframe');
            const doc = frame && frame.contentDocument;
            const win = frame && frame.contentWindow;
            if (doc === null || doc === undefined || win === null || win === undefined) {
              return { present: false };
            }
            if ((win).__astroixHmrMarker !== 'set') (win).__astroixHmrMarker = 'set';
            return {
              present: true,
              carries: [...doc.querySelectorAll('style')].some((s) =>
                (s.textContent ?? '').includes(${needle}),
              ),
              marker: win.__astroixHmrMarker === 'set',
            };
          })()`,
          (value) => (value as { present?: boolean } | null)?.present === true,
          'the canvas hot-update truth',
          30_000,
        );
        report({ kind: 'canvas-hmr', hmr, needle: command.needle });
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
