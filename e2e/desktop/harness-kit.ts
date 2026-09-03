import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

/**
 * The shared real-Electron harness kit of the `e2e/desktop` lanes: one
 * `HarnessRun` (spawn the real Electron binary over a lane-built
 * harness main; drive it over a line protocol on stdin/stdout) and the
 * shared vite bundling of a harness entry. Born at the second consumer
 * (#247's service-worker lane over #246's document-authority lane —
 * the house rule: a shared helper is born when the second consumer
 * appears, and stays as small as its job).
 *
 * The kit also carries the one behavioral fix the duplicated copies
 * hid: stdout is LINE-BUFFERED — a report line split across two `data`
 * chunk boundaries is accumulated and emitted only once complete. The
 * per-chunk parsers both lanes carried would silently drop such a
 * fragment and surface it as a 30-second timeout (a latent flake under
 * backpressure; fixed here once, for every lane).
 *
 * Lane gates only — this file exists for real-Electron spec files run
 * behind `npm run test:desktop`; never release evidence (ADR-0008).
 */

/** The repository root (the spec files and this kit live under `e2e/desktop`). */
export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The workspace's pinned Electron binary (ADR-0008: exactly 44.1.0). */
export const ELECTRON = join(REPO, 'node_modules', '.bin', 'electron');

/** One protocol event off a harness main: a `kind` plus open fields. */
export interface HarnessEvent {
  readonly kind: string;
  readonly [field: string]: unknown;
}

/** What one lane parameterizes: its bundle, its report-line prefix, extra argv. */
export interface HarnessRunOptions {
  /** The lane-built harness main (see `buildHarnessMain`). */
  readonly bundle: string;
  /** The stdout prefix one lane's reports carry (`astroix-…-harness: `). */
  readonly reportPrefix: string;
  /** Extra argv after the bundle (e.g. a JSON config argument). */
  readonly argv?: readonly string[];
}

/** One spawned harness run: the line protocol over the real Electron main. */
export class HarnessRun {
  readonly child: ChildProcess;
  readonly events: HarnessEvent[] = [];
  /** The child's stderr tail, bounded — a harness crash must surface as error text, never an opaque timeout (#129's law: keep the error text; truncation ate the one unexplained red). */
  readonly stderrLines: string[] = [];
  private readonly reportPrefix: string;
  /** The trailing partial stdout line, carried until its `\n` arrives. */
  private stdoutRemainder = '';
  private readonly waiters: {
    match: (event: HarnessEvent, seq: number) => boolean;
    resolve: (event: HarnessEvent) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];

  constructor(options: HarnessRunOptions) {
    this.reportPrefix = options.reportPrefix;
    this.child = spawn(ELECTRON, [options.bundle, ...(options.argv ?? [])], {
      cwd: REPO,
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.pump(chunk);
    });
    // Capture the full stderr, tail-bounded — the red-run diagnosis law.
    this.child.stderr?.on('data', (chunk: Buffer) => {
      for (const raw of chunk.toString('utf8').split('\n')) {
        const line = raw.trim();
        if (line.length > 0) this.stderrLines.push(line);
      }
      while (this.stderrLines.length > 50) this.stderrLines.shift();
    });
    // The quit write can race the child's own exit (a destroyed-target
    // leg leaves no windows and Electron can quit with it): a dead-pipe
    // write must stay a swallowed event, never an unhandled EPIPE.
    this.child.stdin?.on('error', () => {});
  }

  /**
   * One stdout chunk: the carried remainder plus the chunk splits into
   * COMPLETE lines only — the last, possibly incomplete fragment is
   * carried forward, so a report line split across chunk boundaries is
   * parsed exactly once, never as two droppable fragments.
   */
  private pump(chunk: Buffer): void {
    const text = this.stdoutRemainder + chunk.toString('utf8');
    const lines = text.split('\n');
    this.stdoutRemainder = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith(this.reportPrefix)) continue;
      let event: HarnessEvent;
      try {
        event = JSON.parse(line.slice(this.reportPrefix.length)) as HarnessEvent;
      } catch {
        continue;
      }
      const seq = this.events.length;
      this.events.push(event);
      for (let index = 0; index < this.waiters.length; index += 1) {
        const waiter = this.waiters[index];
        if (waiter?.match(event, seq)) {
          clearTimeout(waiter.timer);
          this.waiters.splice(index, 1);
          waiter.resolve(event);
          index -= 1;
        }
      }
    }
  }

  private timeoutError(what: string): Error {
    return new Error(
      `timed out waiting for ${what}; events so far:\n${JSON.stringify(this.events)}` +
        `\nchild stderr tail:\n${this.stderrLines.slice(-20).join('\n') || '(empty)'}`,
    );
  }

  send(command: Record<string, unknown>): void {
    if (this.child.stdin?.writable) {
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
    }
  }

  /** Waits for the first event matching `match` — already-seen events included. */
  waitFor(match: (event: HarnessEvent) => boolean, what: string): Promise<HarnessEvent> {
    const already = this.events.find(match);
    if (already !== undefined) return Promise.resolve(already);
    return this.waitForNext((event) => match(event), what);
  }

  /**
   * Waits for a strictly FUTURE event (`seq` is the event's index, so a
   * caller that snapshots `events.length` before sending can demand its
   * own response — never a stale earlier one).
   */
  waitForNext(
    match: (event: HarnessEvent, seq: number) => boolean,
    what: string,
  ): Promise<HarnessEvent> {
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve,
        timer: setTimeout(() => {
          const at = this.waiters.indexOf(waiter);
          if (at !== -1) this.waiters.splice(at, 1);
          reject(this.timeoutError(what));
        }, 30_000),
      };
      this.waiters.push(waiter);
    });
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.send({ op: 'quit' });
    await Promise.race([
      new Promise((resolve) => this.child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (this.child.exitCode === null) {
      this.child.kill('SIGKILL');
      await new Promise((resolve) => this.child.once('exit', resolve));
    }
  }
}

/**
 * Bundles one lane's harness main with the shared rules (the
 * workspace's own toolchain; only `electron` and the node builtins
 * stay external) and returns the bundle path.
 */
export async function buildHarnessMain(entry: string, outDir: string): Promise<string> {
  await build({
    root: REPO,
    configFile: false,
    logLevel: 'silent',
    build: {
      target: 'node20',
      outDir,
      emptyOutDir: true,
      minify: false,
      lib: {
        entry,
        formats: ['es'],
        fileName: () => 'harness.js',
      },
      rollupOptions: {
        external: (id) => id === 'electron' || id.startsWith('node:'),
        output: { entryFileNames: 'harness.js' },
      },
    },
  });
  return join(outDir, 'harness.js');
}
