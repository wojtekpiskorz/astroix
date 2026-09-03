import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { findDisclosure } from '../../packages/protocol/src/sanitization.ts';
import { type HarnessEvent, HarnessRun } from './harness-kit.ts';

/**
 * The exact-packaged-app kit of the early packaged smoke (#248, H6): the
 * shared machinery the `e2e/desktop/early-package*.spec.ts` family runs
 * against the REAL extracted ZIP artifact (`npm run package`'s sole
 * deliverable) — never an instrumented development build (ADR-0008: the
 * packaged smoke is H6's evidence).
 *
 * What lives here and nowhere else:
 *
 * - **The artifact contract** — the ZIP is located through the
 *   `ASTROIX_EARLY_PACKAGE_ZIP` the runner injects, falling back to the
 *   sole `.zip` under the maker output; with neither present the specs
 *   self-skip (the #339 pattern, like H2's packaged-spawn and H3's
 *   packaged-app lanes — `npm test` stays deterministic).
 * - **Extraction** — `ditto -x -k` (the packaging pipeline's own
 *   extraction stage idiom) into a fresh staging root, asserting the
 *   ZIP's root is exactly one `Astroix.app`.
 * - **The real launch** — `PackagedAppRun`, a thin subclass of the
 *   shared `harness-kit.ts` run (the third consumer of its one
 *   line-buffered pump, waiter registry, stderr bound, and
 *   quit-then-SIGKILL stop): the app executable with an ISOLATED temp HOME and the
 *   product's `ASTROIX_DESKTOP_USER_DATA` override (the H1 isolation
 *   law), every dev-only env declaration REMOVED so the packaged laws
 *   are the only ones that can fire, plus the browser-level
 *   `--user-data-dir` switch (see the constructor).
 * - **The real product driving surface** — the native application menu
 *   and the native directory picker through System Events AppleScript
 *   (the real registration flow: `File > Add Existing Project…` →
 *   NSOpenPanel → the registry's sanitized `registered` event), and the
 *   normal quit through the Apple event (the same event Cmd+Q sends).
 * - **The audits** — process-tree observation and stray-process sweep
 *   over the staging roots, listening-socket evidence, temp-root
 *   diffs, the managed-project byte/metadata snapshot (the shared
 *   `e2e/managed-project-snapshot.ts` — the zero-injection law, one
 *   home with the web lane), and the public-log sanitization scan
 *   (AC-6: the protocol's own `findDisclosure` shapes — paths, PIDs,
 *   ports, environment values — plus the 64-hex digest check local to
 *   this lane).
 *
 * Lane gate machinery, never release evidence on its own — the recorded
 * run under `apps/desktop/test-results/early-package-smoke/` is the
 * evidence artifact the runner composes from these legs.
 */

const execFileAsync = promisify(execFile);

/** The repository root (the harness-kit idiom). */
export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The maker output directory — the fallback ZIP location (a local `npm run package`). */
const MAKER_ZIP_DIR = join(REPO, 'apps', 'desktop', 'out', 'make', 'zip', 'darwin', 'arm64');

/** The product bundle identifier (ADR-0008 identity) — the Apple-event target. */
export const BUNDLE_ID = 'dev.astroix.app';

/**
 * The exact ZIP the smoke runs: the runner-injected path first (the
 * recorded run's artifact), then the sole local build. `undefined` means
 * no local package exists — the specs self-skip (deterministic `npm test`).
 */
export function resolvePackageZip(): string | undefined {
  const injected = process.env.ASTROIX_EARLY_PACKAGE_ZIP;
  if (injected !== undefined && injected.length > 0) {
    if (!existsSync(injected)) {
      throw new Error(
        `early-package: ASTROIX_EARLY_PACKAGE_ZIP points at a missing file (${injected}) — refusing to fall back to a different artifact`,
      );
    }
    return injected;
  }
  if (existsSync(MAKER_ZIP_DIR)) {
    const zips = readdirSync(MAKER_ZIP_DIR).filter((name) => name.endsWith('.zip'));
    if (zips.length === 1) return join(MAKER_ZIP_DIR, zips[0] ?? '');
  }
  return undefined;
}

/** The resolved artifact, or `undefined` when the specs must self-skip. */
export const PACKAGE_ZIP: string | undefined = resolvePackageZip();

/** One fresh staging root the whole spec family isolates a run inside. */
export async function makeStagingRoot(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

/**
 * Extracts the ZIP into `into` and returns the app path — the same
 * extraction law as the packaging pipeline's stage 9 (the ADR-0008
 * "verification runs again after extraction" idiom).
 */
export async function extractPackagedApp(zip: string, into: string): Promise<string> {
  await execFileAsync('ditto', ['-x', '-k', zip, into], { timeout: 5 * 60_000 });
  const roots = await readdir(into);
  if (roots.length !== 1 || roots[0] !== 'Astroix.app') {
    throw new Error(
      `early-package: the extracted ZIP root is not exactly Astroix.app: ${JSON.stringify(roots)}`,
    );
  }
  const appPath = join(into, 'Astroix.app');
  if (!existsSync(join(appPath, 'Contents', 'MacOS', 'Astroix'))) {
    throw new Error('early-package: the extracted app carries no executable');
  }
  return appPath;
}

/** The managed-project snapshot's single home: `e2e/managed-project-snapshot.ts` (shared with the web lane). */
export { snapshotManagedProject } from '../managed-project-snapshot.ts';

// ——— the real launch ———

/** One product log event parsed off the app's stdout (`astroix-desktop: ` lines) — the harness-kit event shape. */
export type DesktopEvent = HarnessEvent;

/** The closed event vocabulary the product log may carry (the sanitization law's shape half). */
export const DESKTOP_EVENT_KINDS: ReadonlySet<string> = new Set([
  'singleton-refused',
  'second-instance',
  'control-plane-booted',
  'control-plane-lost',
  'registered',
  'registration-refused',
  'selection-canceled',
  'menu-action-rejected',
  'quit-settled',
]);

/** The product's own log prefix — the public surface AC-6 audits. */
const DESKTOP_LOG_PREFIX = 'astroix-desktop: ';

/** Where one launch isolates the app: the temp HOME plus the product's user-data override. */
export interface IsolationRoots {
  readonly staging: string;
  readonly home: string;
  readonly userData: string;
}

/**
 * One launched packaged app: the shared `harness-kit.ts` run (its one
 * line-buffered pump, waiter registry, bounded stderr tail, and
 * quit-then-SIGKILL stop) over the REAL app executable — thin, carrying
 * only the packaged lane's own laws.
 */
export class PackagedAppRun extends HarnessRun {
  readonly roots: IsolationRoots;
  readonly appPath: string;

  constructor(appPath: string, roots: IsolationRoots) {
    // The packaged laws only: every dev-only env declaration is REMOVED,
    // so nothing but the product's packaged resolution can decide the boot.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ASTROIX_DESKTOP_NODE;
    delete env.ASTROIX_DESKTOP_SMOKE;
    delete env.ASTROIX_DESKTOP_DEV_CURRENT_PIN;
    env.HOME = roots.home;
    env.ASTROIX_DESKTOP_USER_DATA = roots.userData;
    env.ELECTRON_ENABLE_LOGGING = '0';
    super({
      executable: join(appPath, 'Contents', 'MacOS', 'Astroix'),
      // The browser-level `--user-data-dir` switch — the isolation law's
      // harness half. Chromium resolves the browser's user-data-dir at
      // process start and hands it to EVERY helper; the product's env
      // override (`app.setPath` in main) lands only after the pre-boot
      // resource verification, so without the switch the early GPU and
      // network helpers run against the REAL account home's Application
      // Support (observed in the first recorded run; the product half —
      // setPath's late landing — is #363). The switch names the SAME
      // temp root as the env override, so the app's own paths are
      // unchanged — every process of the tree, first to last, is isolated.
      argv: [`--user-data-dir=${roots.userData}`],
      env,
      cwd: roots.staging,
      reportPrefix: DESKTOP_LOG_PREFIX,
    });
    this.appPath = appPath;
    this.roots = roots;
  }

  /** The product's own log lines (the AC-6 audit surface). */
  get productLogLines(): string[] {
    return this.stdoutLines.filter((line) => line.startsWith(DESKTOP_LOG_PREFIX));
  }

  /** Waits for one product event kind (already-seen included; the real-GUI bound default). */
  waitForEvent(kind: string, what: string, timeoutMs = 90_000): Promise<DesktopEvent> {
    return this.waitFor((event) => event.kind === kind, what, timeoutMs);
  }

  /**
   * Cleanup-only stop (a leg that failed before its own quit path) —
   * the shared ordered stop, nothing else: the ONE settled predicate
   * (code OR signal) lives there, so a signal-killed app settles
   * immediately instead of hanging the afterAll to the hook timeout
   * (the hole review round 4 closed, with a leg proving it in
   * `early-package-harness-lifecycle.spec.ts`).
   */
  async killForCleanup(): Promise<void> {
    await this.stop();
  }
}

// ——— the real product driving surface (System Events) ———

async function osascript(script: string, timeoutMs = 30_000): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('osascript', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('early-package: osascript timed out'));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (code === 0) resolve(text);
      else reject(new Error(`early-package: osascript failed (${code}): ${text}`));
    });
    child.stdin?.on('error', () => {});
    child.stdin?.write(script);
    child.stdin?.end();
  });
}

/** True when System Events UI scripting (menu clicks + keystrokes) is available to this host. */
export async function uiScriptingAvailable(): Promise<boolean> {
  try {
    await osascript('tell application "System Events" to keystroke ""', 15_000);
    return true;
  } catch {
    return false;
  }
}

/** Brings the packaged app frontmost (the picker drive's precondition). */
export async function activateApp(): Promise<void> {
  await osascript(`tell application id "${BUNDLE_ID}" to activate`, 15_000);
  await delay(500);
}

/** The application menu, enumerated: one `menu > item` row per entry (the product's real surface). */
export async function enumerateApplicationMenu(): Promise<string[]> {
  // Numeric indexing throughout: menu bar items and their menus are
  // addressed by position (names can collide with AppleScript class
  // words); separators report `missing value` and are dropped here.
  const script = `
tell application "System Events"
  tell process "Astroix"
    set output to ""
    repeat with i from 1 to (count of menu bar items of menu bar 1)
      set output to output & "menu: " & (name of menu bar item i of menu bar 1) & linefeed
      try
        repeat with j from 1 to (count of menu items of menu 1 of menu bar item i of menu bar 1)
          set itemName to (name of menu item j of menu 1 of menu bar item i of menu bar 1) as text
          if itemName is not "missing value" then set output to output & "  item: " & itemName & linefeed
        end repeat
      end try
    end repeat
    return output
  end tell
end tell`;
  const text = await osascript(script, 30_000);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes('missing value'));
}

/**
 * Registers `projectRoot` through the REAL native flow: the application
 * menu's `File > Add Existing Project…` opens the native directory
 * picker; the picker receives the path (Go-to-Folder + confirm + Open).
 * Resolves when the product logged its `registered` event — the
 * registry's own sanitized summary, never a path.
 */
export async function registerThroughNativePicker(
  run: PackagedAppRun,
  projectRoot: string,
): Promise<DesktopEvent> {
  if (/["\\\n]/.test(projectRoot)) {
    throw new Error(`early-package: a picker path must be AppleScript-safe (${projectRoot})`);
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await activateApp();
      await osascript(
        `tell application "System Events"
  tell process "Astroix"
    click menu item "Add Existing Project…" of menu "File" of menu bar item "File" of menu bar 1
  end tell
end tell`,
        30_000,
      );
      await delay(1200);
      await osascript(
        `tell application "System Events"
  tell process "Astroix"
    keystroke "g" using {command down, shift down}
    delay 0.6
    keystroke "${projectRoot}"
    delay 0.4
    keystroke return
    delay 1
    keystroke return
  end tell
end tell`,
        30_000,
      );
      const event = await run.waitForEvent('registered', 'the native registration event', 20_000);
      return event;
    } catch (error) {
      lastError = error;
      // dismiss a possibly-stuck sheet before any retry
      await osascript(
        'tell application "System Events" to keystroke (character id 27)', // Escape
        10_000,
      ).catch(() => {});
    }
  }
  throw new Error(
    `early-package: the native picker registration did not complete (${String(lastError)}); ` +
      `product log:\n${run.productLogLines.join('\n')}`,
  );
}

/** The normal quit: the Apple event Cmd+Q sends — the product's own quit transition. */
export async function quitNormally(run: PackagedAppRun): Promise<void> {
  await osascript(`tell application id "${BUNDLE_ID}" to quit`, 20_000);
  await run.waitForEvent('quit-settled', 'the quit transition settling', 90_000);
  const settled = await Promise.race([
    run.exit,
    new Promise<{ code: number | null; signal: string | null }>((_, reject) =>
      setTimeout(
        () => reject(new Error('early-package: the app did not exit after quit-settled')),
        30_000,
      ),
    ),
  ]);
  if (settled.code !== 0) {
    throw new Error(
      `early-package: the app exited with ${String(settled.code)} (${String(settled.signal)})`,
    );
  }
}

// ——— the audits ———

/**
 * The isolation audit over one captured process tree: NO process of the
 * launched app's tree may reference the REAL account home — the
 * isolation law (a temp HOME + temp user data only). Born from the
 * first recorded run's finding: without the browser-level
 * `--user-data-dir` switch, Chromium's early GPU and network helpers
 * ran against the real home's Application Support even under a temp
 * `$HOME` (the browser resolves its user-data-dir before the product's
 * env override lands); the switch is now part of the launch, and this
 * audit holds the law in every recorded run.
 */
export function realHomeIsolationFindings(
  tree: ReadonlyArray<{ readonly pid: string; readonly command: string }>,
  realHome: string,
): string[] {
  const findings: string[] = [];
  for (const row of tree) {
    if (row.command.includes(realHome)) {
      findings.push(`process ${row.pid} references the real account home (${realHome})`);
    }
  }
  return findings;
}

/**
 * The live process tree referencing `root` (the app executable, the
 * bundled-Node control-plane child) — evidence captured while the run
 * is alive, and the sweep's baseline after quit.
 */
export async function processesReferencing(
  root: string,
): Promise<
  ReadonlyArray<{ readonly pid: string; readonly ppid: string; readonly command: string }>
> {
  let pids: string;
  try {
    const result = await execFileAsync('pgrep', ['-f', root], { timeout: 30_000 });
    pids = result.stdout;
  } catch {
    return []; // pgrep exits 1 when nothing matches — the audit's healthy state
  }
  const list = pids
    .split('\n')
    .map((pid) => pid.trim())
    .filter((pid) => pid.length > 0)
    .filter((pid) => pid !== String(process.pid));
  if (list.length === 0) return [];
  const { stdout } = await execFileAsync(
    'ps',
    ['-o', 'pid=,ppid=,command=', '-p', list.join(',')],
    {
      timeout: 30_000,
    },
  );
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split(/\s+/);
      return { pid: parts[0] ?? '?', ppid: parts[1] ?? '?', command: parts.slice(2).join(' ') };
    });
}

/** The TCP listeners the given PIDs hold right now (socket evidence; `lsof` exits 1 on none). */
export async function listeningSockets(pids: readonly string[]): Promise<string[]> {
  if (pids.length === 0) return [];
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', pids.join(',')],
      { timeout: 30_000 },
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** The top-level entries of the system temp root (the temporary-root audit's snapshots). */
export async function tmpTopLevel(): Promise<Set<string>> {
  return new Set(await readdir(tmpdir()));
}

/** One 64-hex digest shape — the one disclosure class the protocol guard does not carry (internal hashes, not wire text). */
const HEX64 = /(^|[^0-9a-f])[0-9a-f]{64}([^0-9a-f]|$)/;

/**
 * The AC-6 sanitization scan over the product's own log lines: the
 * PROTOCOL's own disclosure guard (`findDisclosure` — the same shapes
 * every public free-text field passes: any POSIX absolute path wherever
 * it points, home-relative, Windows-drive, UNC, stack frames, PID,
 * port, environment values), plus the one digest check local to this
 * lane (internal 64-hex hashes are not wire text, so the protocol
 * guard does not carry them). Root-membership is deliberately NOT the
 * law here — a leaked absolute path is a disclosure regardless of
 * where it points.
 */
export function sanitizationFindings(productLogLines: readonly string[]): string[] {
  const findings: string[] = [];
  for (const line of productLogLines) {
    const disclosure = findDisclosure(line);
    if (disclosure !== null) {
      findings.push(`a ${disclosure.what} disclosure shape (${disclosure.id})`);
    }
    if (HEX64.test(line)) findings.push('a 64-hex digest leaked');
  }
  return findings;
}

/** Removes a staging root (the macOS long-path fallback is the orchestrator's, not the spec's). */
export async function removeStaging(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

/** One bounded delay. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
